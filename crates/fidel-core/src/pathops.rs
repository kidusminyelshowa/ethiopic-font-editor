//! Path operations on outlines: remove overlap, booleans, offset, expand
//! stroke and knife cuts, at the level of Glyphs and FontLab. Built on
//! `flo_curves`' path arithmetic; contours go in and out in UFO point order.

use flo_curves::bezier::path::{
    path_add, path_intersect, path_remove_interior_points, path_sub, stroke_path, LineCap, LineJoin,
    SimpleBezierPath, StrokeOptions,
};
use flo_curves::Coord2;
use serde::{Deserialize, Serialize};

use crate::geometry::{Contour, ContourId, Point, PointKind, Vec2};

/// How close two points must be to count as the same, in font units.
const ACCURACY: f64 = 0.01;

/// A boolean between two sets of contours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BooleanOp {
    /// Everything covered by either.
    Union,
    /// The first, minus the second.
    Subtract,
    /// Only what both cover.
    Intersect,
    /// What one or the other covers, but not both.
    Exclude,
}

/// How a stroke's corners and ends are drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum StrokeJoin {
    #[default]
    Miter,
    Round,
    Bevel,
}

/// One path operation, as the editor asks for it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum PathOp {
    RemoveOverlap { contours: Vec<Contour> },
    Boolean { a: Vec<Contour>, b: Vec<Contour>, kind: BooleanOp, first_id: ContourId },
    Offset { contours: Vec<Contour>, distance: f64, join: StrokeJoin, first_id: ContourId },
    ExpandStroke { contours: Vec<Contour>, width: f64, join: StrokeJoin, first_id: ContourId },
    Knife { contours: Vec<Contour>, from: Vec2, to: Vec2, first_id: ContourId },
}

impl PathOp {
    /// Run the operation; returns the contours that replace the input.
    pub fn run(&self) -> Vec<Contour> {
        match self {
            PathOp::RemoveOverlap { contours } => remove_overlap(contours),
            PathOp::Boolean { a, b, kind, first_id } => boolean(a, b, *kind, *first_id),
            PathOp::Offset { contours, distance, join, first_id } => {
                offset(contours, *distance, *join, *first_id)
            }
            PathOp::ExpandStroke { contours, width, join, first_id } => {
                expand_stroke(contours, *width, *join, *first_id)
            }
            PathOp::Knife { contours, from, to, first_id } => knife(contours, *from, *to, *first_id),
        }
    }
}

/// Merge overlapping contours into one outline, keeping counters.
pub fn remove_overlap(contours: &[Contour]) -> Vec<Contour> {
    let closed: Vec<&Contour> = contours.iter().filter(|c| !c.open).collect();
    if closed.is_empty() {
        return contours.to_vec();
    }
    // Each shape is an outer contour minus the counters directly inside it;
    // the shapes are then added together one by one.
    let mut acc: Vec<SimpleBezierPath> = Vec::new();
    for (outer, holes) in shapes(&closed) {
        let holes: Vec<SimpleBezierPath> = holes.iter().map(|&h| to_path(closed[h])).collect();
        let outer = vec![to_path(closed[outer])];
        let shape: Vec<SimpleBezierPath> = if holes.is_empty() {
            path_remove_interior_points(&outer, ACCURACY)
        } else {
            path_sub(&outer, &holes, ACCURACY)
        };
        acc = if acc.is_empty() { shape } else { path_add(&acc, &shape, ACCURACY) };
    }
    let mut out = from_paths(&acc, first_free_id(contours));
    out.extend(contours.iter().filter(|c| c.open).cloned());
    out
}

/// Group contours into shapes: each outer contour (at an even nesting depth)
/// with the counters directly inside it.
fn shapes(closed: &[&Contour]) -> Vec<(usize, Vec<usize>)> {
    let polys: Vec<Vec<Vec2>> = closed.iter().map(|c| flatten(c)).collect();
    let areas: Vec<f64> = polys.iter().map(|p| poly_area(p).abs()).collect();
    let n = closed.len();
    let inside = |i: usize, j: usize| {
        // Nested only when wholly inside: paths that merely overlap are not counters.
        i != j && areas[j] > areas[i] && polys[i].iter().all(|&p| contains(&polys[j], p))
    };
    let depth: Vec<usize> = (0..n).map(|i| (0..n).filter(|&j| inside(i, j)).count()).collect();
    (0..n)
        .filter(|&i| depth[i].is_multiple_of(2))
        .map(|i| (i, (0..n).filter(|&h| depth[h] == depth[i] + 1 && inside(h, i)).collect()))
        .collect()
}

/// The contour as a polygon, curves sampled.
pub(crate) fn flatten(c: &Contour) -> Vec<Vec2> {
    let mut out = Vec::new();
    for s in segments(c) {
        if s.len() == 4 {
            for k in 0..8 {
                let t = k as f64 / 8.0;
                let u = 1.0 - t;
                out.push(
                    s[0] * (u * u * u)
                        + s[1] * (3.0 * u * u * t)
                        + s[2] * (3.0 * u * t * t)
                        + s[3] * (t * t * t),
                );
            }
        } else {
            out.push(s[0]);
        }
    }
    out
}

fn poly_area(p: &[Vec2]) -> f64 {
    let n = p.len();
    (0..n).map(|i| p[i].x * p[(i + 1) % n].y - p[(i + 1) % n].x * p[i].y).sum::<f64>() / 2.0
}

fn contains(poly: &[Vec2], p: Vec2) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.saturating_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// A boolean between two sets of closed contours. Returns the new contours.
pub fn boolean(a: &[Contour], b: &[Contour], op: BooleanOp, first_id: ContourId) -> Vec<Contour> {
    let pa: Vec<SimpleBezierPath> = a.iter().filter(|c| !c.open).map(to_path).collect();
    let pb: Vec<SimpleBezierPath> = b.iter().filter(|c| !c.open).map(to_path).collect();
    let out: Vec<SimpleBezierPath> = match op {
        BooleanOp::Union => path_add(&pa, &pb, ACCURACY),
        BooleanOp::Subtract => path_sub(&pa, &pb, ACCURACY),
        BooleanOp::Intersect => path_intersect(&pa, &pb, ACCURACY),
        BooleanOp::Exclude => {
            let mut x: Vec<SimpleBezierPath> = path_sub(&pa, &pb, ACCURACY);
            x.extend(path_sub::<SimpleBezierPath>(&pb, &pa, ACCURACY));
            x
        }
    };
    from_paths(&out, first_id)
}

/// Grow (positive `d`) or shrink (negative) closed contours by `d` units.
pub fn offset(contours: &[Contour], d: f64, join: StrokeJoin, first_id: ContourId) -> Vec<Contour> {
    if d.abs() < 1e-9 {
        return contours.to_vec();
    }
    // Each shape grows or shrinks on its own, so separate parts stay separate.
    let closed: Vec<&Contour> = contours.iter().filter(|c| !c.open).collect();
    let mut out = Vec::new();
    let mut next = first_id;
    for (outer, holes) in shapes(&closed) {
        let paths: Vec<SimpleBezierPath> =
            std::iter::once(outer).chain(holes).map(|i| to_path(closed[i])).collect();
        // A band of width 2|d| around every edge, added to or taken from the shape.
        let mut band: Vec<SimpleBezierPath> = Vec::new();
        for p in &paths {
            band.extend(stroke_path::<SimpleBezierPath, Coord2>(
                p,
                2.0 * d.abs(),
                &stroke_options(join, true),
            ));
        }
        let band: Vec<SimpleBezierPath> = path_remove_interior_points(&band, ACCURACY);
        let res: Vec<SimpleBezierPath> =
            if d > 0.0 { path_add(&paths, &band, ACCURACY) } else { path_sub(&paths, &band, ACCURACY) };
        let src = closed[outer];
        for piece in from_paths(&res, next) {
            out.push(Contour { part: src.part, name: src.name.clone(), ..piece });
        }
        next = out.iter().map(|c| c.id + 1).max().unwrap_or(next).max(next);
    }
    out.extend(contours.iter().filter(|c| c.open).cloned());
    out
}

/// Turn paths into outlines `width` units wide: open paths get ends, closed
/// ones become rings.
pub fn expand_stroke(
    contours: &[Contour],
    width: f64,
    join: StrokeJoin,
    first_id: ContourId,
) -> Vec<Contour> {
    let mut out: Vec<SimpleBezierPath> = Vec::new();
    for c in contours {
        let p = to_path(c);
        out.extend(stroke_path::<SimpleBezierPath, Coord2>(&p, width, &stroke_options(join, !c.open)));
    }
    let out: Vec<SimpleBezierPath> = path_remove_interior_points(&out, ACCURACY);
    from_paths(&out, first_id)
}

/// Cut closed contours along the line from `a` to `b`, extended across the
/// whole drawing. Each contour the line crosses comes back as separate pieces.
pub fn knife(contours: &[Contour], a: Vec2, b: Vec2, first_id: ContourId) -> Vec<Contour> {
    let dir = b - a;
    let len = dir.x.hypot(dir.y);
    if len < 1e-6 {
        return contours.to_vec();
    }
    let u = Vec2::new(dir.x / len, dir.y / len);
    let n = Vec2::new(-u.y, u.x);
    let far = 1.0e5;
    let half = |side: f64| -> SimpleBezierPath {
        let p0 = a - u * far;
        let p1 = a + u * far;
        let p2 = p1 + n * (far * side);
        let p3 = p0 + n * (far * side);
        polygon(&[p0, p1, p2, p3])
    };
    let (left, right) = (vec![half(1.0)], vec![half(-1.0)]);
    let mut out = Vec::new();
    let mut next = first_id;
    for c in contours {
        if c.open {
            out.push(c.clone());
            continue;
        }
        let p = vec![to_path(c)];
        let l: Vec<SimpleBezierPath> = path_intersect(&p, &left, ACCURACY);
        let r: Vec<SimpleBezierPath> = path_intersect(&p, &right, ACCURACY);
        if l.is_empty() || r.is_empty() {
            // The line misses this contour.
            out.push(c.clone());
            continue;
        }
        for piece in from_paths(&l, next).into_iter().chain(from_paths(&r, next + l.len() as u32)) {
            out.push(Contour { part: c.part, name: c.name.clone(), ..piece });
        }
        next += (l.len() + r.len()) as u32;
    }
    out
}

fn stroke_options(join: StrokeJoin, closed: bool) -> StrokeOptions {
    let j = match join {
        StrokeJoin::Miter => LineJoin::Miter,
        StrokeJoin::Round => LineJoin::Round,
        StrokeJoin::Bevel => LineJoin::Bevel,
    };
    StrokeOptions::default()
        .with_accuracy(0.1)
        .with_join(j)
        .with_start_cap(LineCap::Butt)
        .with_end_cap(LineCap::Butt)
        .with_closed(closed)
}

fn first_free_id(contours: &[Contour]) -> ContourId {
    contours.iter().map(|c| c.id + 1).max().unwrap_or(0)
}

fn c2(v: Vec2) -> Coord2 {
    Coord2(v.x, v.y)
}

fn v2(c: Coord2) -> Vec2 {
    Vec2::new(c.0, c.1)
}

fn polygon(pts: &[Vec2]) -> SimpleBezierPath {
    let mut curves = Vec::new();
    for i in 1..=pts.len() {
        let (p, q) = (pts[i - 1], pts[i % pts.len()]);
        curves.push((c2(p + (q - p) * (1.0 / 3.0)), c2(p + (q - p) * (2.0 / 3.0)), c2(q)));
    }
    (c2(pts[0]), curves)
}

/// A contour as a flo_curves path: lines become straight cubics.
pub(crate) fn to_path(c: &Contour) -> SimpleBezierPath {
    let segs = segments(c);
    let start = segs.first().map(|s| s[0]).unwrap_or(Vec2::ZERO);
    let curves = segs
        .iter()
        .map(|s| match s.len() {
            4 => (c2(s[1]), c2(s[2]), c2(s[3])),
            _ => {
                let (p, q) = (s[0], s[1]);
                (c2(p + (q - p) * (1.0 / 3.0)), c2(p + (q - p) * (2.0 / 3.0)), c2(q))
            }
        })
        .collect();
    (c2(start), curves)
}

/// The segments of a contour: [p0, p3] for a line, [p0, p1, p2, p3] for a curve.
pub fn segments(c: &Contour) -> Vec<Vec<Vec2>> {
    let n = c.points.len();
    let Some(start) = c.points.iter().position(Point::is_on_curve) else {
        return Vec::new();
    };
    let steps = if c.open { n - 1 } else { n };
    let mut out = Vec::new();
    let mut cur = vec![c.points[start].pos];
    for i in 1..=steps {
        let p = &c.points[(start + i) % n];
        cur.push(p.pos);
        if p.kind != PointKind::OffCurve {
            let last = *cur.last().unwrap();
            out.push(std::mem::replace(&mut cur, vec![last]));
        }
    }
    out
}

/// Paths back into contours: straight cubics become lines, and points
/// closer than a unit merge.
fn from_paths(paths: &[SimpleBezierPath], first_id: ContourId) -> Vec<Contour> {
    let mut out = Vec::new();
    let mut id = first_id;
    for (start, curves) in paths {
        let mut points: Vec<Point> = Vec::new();
        let mut pid = 0;
        let mut prev = v2(*start);
        let mut segs: Vec<(Vec2, Vec2, Vec2, bool)> = Vec::new();
        for &(c1, c2_, end) in curves {
            let (c1, c2_, end) = (v2(c1), v2(c2_), v2(end));
            if dist(prev, end) < 0.5 && dist(prev, c1) < 0.5 && dist(prev, c2_) < 0.5 {
                continue;
            }
            let straight = on_line(prev, end, c1) && on_line(prev, end, c2_);
            segs.push((c1, c2_, end, straight));
            prev = end;
        }
        if segs.len() < 2 {
            continue;
        }
        // The path ends where it starts: that last point is the first one.
        let first = v2(*start);
        if dist(segs.last().unwrap().2, first) < 0.5 {
            segs.last_mut().unwrap().2 = first;
        }
        let n = segs.len();
        for (i, &(c1, c2_, end, straight)) in segs.iter().enumerate() {
            if !straight {
                points.push(Point::off(pid, round(c1.x), round(c1.y)));
                points.push(Point::off(pid + 1, round(c2_.x), round(c2_.y)));
                pid += 2;
            }
            // The closing segment ends on the start point, which goes first.
            if i == n - 1 && dist(end, first) < 0.5 {
                let kind = if straight { PointKind::Line } else { PointKind::Curve };
                points.insert(
                    0,
                    Point { id: pid, pos: Vec2::new(round(first.x), round(first.y)), kind, smooth: false },
                );
                pid += 1;
                continue;
            }
            let kind = if straight { PointKind::Line } else { PointKind::Curve };
            points.push(Point { id: pid, pos: Vec2::new(round(end.x), round(end.y)), kind, smooth: false });
            pid += 1;
        }
        // Rotate so the list starts on an on-curve point, in UFO order.
        if let Some(k) = points.iter().position(Point::is_on_curve) {
            points.rotate_left(k);
        }
        mark_smooth(&mut points);
        let c = Contour::new(id, None, points);
        if c.validate().is_ok() {
            out.push(c);
            id += 1;
        }
    }
    out
}

/// On-curve points whose handles are in line are smooth.
fn mark_smooth(points: &mut [Point]) {
    let n = points.len();
    for i in 0..n {
        if !points[i].is_on_curve() {
            continue;
        }
        let prev = points[(i + n - 1) % n].pos;
        let next = points[(i + 1) % n].pos;
        let p = points[i].pos;
        let a = p - prev;
        let b = next - p;
        let (la, lb) = (a.x.hypot(a.y), b.x.hypot(b.y));
        if la < 1.0 || lb < 1.0 {
            continue;
        }
        let cross = (a.x * b.y - a.y * b.x) / (la * lb);
        let dot = (a.x * b.x + a.y * b.y) / (la * lb);
        let curved = !points[(i + n - 1) % n].is_on_curve() || !points[(i + 1) % n].is_on_curve();
        if curved && cross.abs() < 0.02 && dot > 0.0 {
            points[i].smooth = true;
        }
    }
}

fn round(v: f64) -> f64 {
    v.round()
}

fn dist(a: Vec2, b: Vec2) -> f64 {
    (a.x - b.x).hypot(a.y - b.y)
}

/// Whether `p` lies on the segment from `a` to `b`, within half a unit.
fn on_line(a: Vec2, b: Vec2, p: Vec2) -> bool {
    let d = b - a;
    let l = d.x.hypot(d.y);
    if l < 1e-9 {
        return dist(a, p) < 0.5;
    }
    let cross = ((p.x - a.x) * d.y - (p.y - a.y) * d.x).abs() / l;
    let t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / (l * l);
    cross < 0.5 && (-0.01..=1.01).contains(&t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(id: u32, x0: f64, y0: f64, x1: f64, y1: f64) -> Contour {
        Contour::rect(id, None, Vec2::new(x0, y0), Vec2::new(x1, y1))
    }

    fn area(c: &Contour) -> f64 {
        // Shoelace over the on-curve points (exact for straight outlines).
        let pts: Vec<Vec2> = c.points.iter().filter(|p| p.is_on_curve()).map(|p| p.pos).collect();
        let n = pts.len();
        (0..n).map(|i| pts[i].x * pts[(i + 1) % n].y - pts[(i + 1) % n].x * pts[i].y).sum::<f64>() / 2.0
    }

    fn total_area(cs: &[Contour]) -> f64 {
        cs.iter().map(|c| area(c).abs()).sum()
    }

    #[test]
    fn ops_come_in_as_json() {
        let op: PathOp =
            serde_json::from_str(r#"{"op":"offset","contours":[],"distance":5,"join":"round","firstId":3}"#)
                .unwrap();
        assert!(op.run().is_empty());
    }

    #[test]
    fn removing_overlap_merges_two_squares() {
        let out = remove_overlap(&[rect(0, 0.0, 0.0, 100.0, 100.0), rect(1, 50.0, 50.0, 150.0, 150.0)]);
        assert_eq!(out.len(), 1);
        assert!((total_area(&out) - 17500.0).abs() < 1.0, "{}", total_area(&out));
        assert!(out[0].points.iter().all(|p| p.kind == PointKind::Line));
        assert_eq!(out[0].points.len(), 8);
    }

    #[test]
    fn removing_overlap_does_not_treat_an_overlapping_corner_as_a_counter() {
        // A stem whose top corner starts inside a wider bar: one shape, no hole.
        let bar = rect(0, 0.0, 600.0, 400.0, 700.0);
        let stem = rect(1, 10.0, 0.0, 90.0, 690.0);
        let out = remove_overlap(&[bar, stem]);
        assert_eq!(out.len(), 1, "{out:?}");
        assert!((total_area(&out) - (40000.0 + 80.0 * 600.0)).abs() < 1.0, "{}", total_area(&out));
    }

    #[test]
    fn removing_overlap_keeps_a_counter() {
        let outer = rect(0, 0.0, 0.0, 300.0, 300.0);
        // A counter runs the other way.
        let mut hole = rect(1, 100.0, 100.0, 200.0, 200.0);
        hole.points.reverse();
        let out = remove_overlap(&[outer, hole]);
        assert_eq!(out.len(), 2, "{out:?}");
        assert!((total_area(&out) - 100000.0).abs() < 1.0);
    }

    #[test]
    fn booleans_on_two_squares() {
        let a = [rect(0, 0.0, 0.0, 100.0, 100.0)];
        let b = [rect(1, 50.0, 0.0, 150.0, 100.0)];
        assert!((total_area(&boolean(&a, &b, BooleanOp::Union, 5)) - 15000.0).abs() < 1.0);
        assert!((total_area(&boolean(&a, &b, BooleanOp::Subtract, 5)) - 5000.0).abs() < 1.0);
        assert!((total_area(&boolean(&a, &b, BooleanOp::Intersect, 5)) - 5000.0).abs() < 1.0);
        let x = boolean(&a, &b, BooleanOp::Exclude, 5);
        assert_eq!(x.len(), 2);
        assert!((total_area(&x) - 10000.0).abs() < 1.0);
        assert_eq!(boolean(&a, &b, BooleanOp::Union, 5)[0].id, 5);
    }

    #[test]
    fn subtracting_a_hole_keeps_it_as_a_counter() {
        let out = boolean(
            &[rect(0, 0.0, 0.0, 300.0, 300.0)],
            &[rect(1, 100.0, 100.0, 200.0, 200.0)],
            BooleanOp::Subtract,
            0,
        );
        assert_eq!(out.len(), 2);
        assert!((total_area(&out) - 100000.0).abs() < 1.0);
    }

    #[test]
    fn offset_grows_and_shrinks_a_square() {
        let sq = [rect(0, 0.0, 0.0, 100.0, 100.0)];
        let grown = offset(&sq, 10.0, StrokeJoin::Miter, 0);
        assert_eq!(grown.len(), 1);
        let b = grown[0].bounds().unwrap();
        assert!((b.min.x + 10.0).abs() < 1.0 && (b.max.y - 110.0).abs() < 1.0, "{b:?}");
        let shrunk = offset(&sq, -10.0, StrokeJoin::Miter, 0);
        let b = shrunk[0].bounds().unwrap();
        assert!((b.min.x - 10.0).abs() < 1.0 && (b.max.y - 90.0).abs() < 1.0, "{b:?}");
    }

    #[test]
    fn offset_keeps_touching_parts_apart() {
        // Two squares that would overlap once grown stay two contours.
        let two = [rect(0, 0.0, 0.0, 100.0, 100.0), rect(1, 105.0, 0.0, 200.0, 100.0)];
        let grown = offset(&two, 10.0, StrokeJoin::Miter, 5);
        assert_eq!(grown.len(), 2);
        assert_ne!(grown[0].id, grown[1].id);
    }

    #[test]
    fn expanding_an_open_line_makes_a_bar() {
        let mut line = Contour::new(0, None, vec![Point::line(0, 0.0, 0.0), Point::line(1, 100.0, 0.0)]);
        line.open = true;
        let out = expand_stroke(&[line], 20.0, StrokeJoin::Miter, 3);
        assert_eq!(out.len(), 1);
        assert!(!out[0].open);
        let b = out[0].bounds().unwrap();
        assert!(
            (b.min.y + 10.0).abs() < 1.0 && (b.max.y - 10.0).abs() < 1.0 && (b.max.x - 100.0).abs() < 1.0,
            "{b:?}"
        );
    }

    #[test]
    fn knife_cuts_a_square_in_two() {
        let out =
            knife(&[rect(0, 0.0, 0.0, 100.0, 100.0)], Vec2::new(50.0, -20.0), Vec2::new(50.0, 120.0), 7);
        assert_eq!(out.len(), 2);
        for c in &out {
            assert!((area(c).abs() - 5000.0).abs() < 1.0);
        }
        // A line that misses leaves the contour alone.
        let same =
            knife(&[rect(0, 0.0, 0.0, 100.0, 100.0)], Vec2::new(200.0, 0.0), Vec2::new(200.0, 10.0), 7);
        assert_eq!(same.len(), 1);
        assert_eq!(same[0].id, 0);
    }
}
