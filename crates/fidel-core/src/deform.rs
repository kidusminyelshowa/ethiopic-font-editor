//! The deforming verbs: shorten, lengthen, stretch and crick change the base's
//! own strokes instead of adding a part (Hornus fig. 4).
//!
//! Each deform picks one stroke of the base with the alteration's placement
//! (any of its parts, then the region: "the stroke that reaches lowest on
//! the left"), then warps it. The warps keep the stroke's terminal intact and only
//! change the shaft, so a leaf or foot drawn on the base survives.

use crate::alteration::{Alteration, Region, Verb, EDGE_TOLERANCE};
use crate::geometry::{Contour, Point, PointKind, Rect, Vec2};
use crate::project::Metrics;

/// A smooth map applied to every point of the deformed stroke, and to
/// components sitting on it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Warp {
    /// Shorten (positive `shift`) or lengthen a stroke along its own axis.
    /// `origin` is where the stroke joins the body and `dir` points from
    /// there to the foot (unit length). The foot, everything past `len -
    /// foot` along the axis, moves back by `shift`; the shaft between is
    /// squashed or stretched along the axis only, so a slanted leg keeps
    /// its slope and its thickness.
    Along { origin: Vec2, dir: Vec2, len: f64, foot: f64, shift: f64 },
    /// Push everything past `z` sideways by `dx` (and down by `dy`):
    /// nothing at `z`, ramping in over `ramp`. `below` warps the part
    /// below `z` (a foot that flicks or sweeps); otherwise the part above
    /// it (a stroke that cricks at the top).
    Sideways { z: f64, ramp: f64, dx: f64, dy: f64, below: bool },
}

impl Warp {
    pub fn apply(&self, p: Vec2) -> Vec2 {
        match *self {
            Warp::Along { origin, dir, len, foot, shift } => {
                let s = (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y;
                let knee = len - foot;
                let ds = if s <= 0.0 {
                    0.0
                } else if s >= knee || knee <= 1e-9 {
                    -shift
                } else {
                    -shift * s / knee
                };
                Vec2::new(p.x + dir.x * ds, p.y + dir.y * ds)
            }
            Warp::Sideways { z, ramp, dx, dy, below } => {
                let past = if below { z - p.y } else { p.y - z };
                let t = if past <= 0.0 {
                    0.0
                } else if ramp <= 1e-9 || past >= ramp {
                    1.0
                } else {
                    past / ramp
                };
                Vec2::new(p.x + dx * t, p.y - dy * t)
            }
        }
    }

    /// Heights where the stroke needs an on-curve point for the warp to bend
    /// it in the right place.
    fn creases(&self) -> Vec<f64> {
        match *self {
            Warp::Along { .. } => Vec::new(),
            Warp::Sideways { z, ramp, below, .. } => vec![z, if below { z - ramp } else { z + ramp }],
        }
    }
}

/// Which way a region points: -1 for the left, +1 for the right.
fn side(region: Region) -> f64 {
    match region {
        Region::TopLeft | Region::MiddleLeft | Region::BottomLeft => -1.0,
        _ => 1.0,
    }
}

fn is_top(region: Region) -> bool {
    matches!(region, Region::TopLeft | Region::TopRight)
}

/// Pick the stroke to deform among `candidates` (index, bounds).
pub fn pick(candidates: &[(usize, Rect)], region: Region) -> Option<usize> {
    let right = side(region) > 0.0;
    let by_side = |a: &Rect, b: &Rect| {
        if right {
            a.max.x.total_cmp(&b.max.x)
        } else {
            b.min.x.total_cmp(&a.min.x)
        }
    };
    let pool: Vec<&(usize, Rect)> = match region {
        Region::BottomLeft | Region::BottomRight => {
            let lowest = candidates.iter().map(|(_, b)| b.min.y).fold(f64::INFINITY, f64::min);
            candidates.iter().filter(|(_, b)| b.min.y <= lowest + EDGE_TOLERANCE).collect()
        }
        Region::TopLeft | Region::TopRight => {
            let highest = candidates.iter().map(|(_, b)| b.max.y).fold(f64::NEG_INFINITY, f64::max);
            candidates.iter().filter(|(_, b)| b.max.y >= highest - EDGE_TOLERANCE).collect()
        }
        Region::MiddleLeft | Region::MiddleRight => candidates.iter().collect(),
    };
    pool.into_iter().max_by(|(_, a), (_, b)| by_side(a, b)).map(|(i, _)| *i)
}

/// Pick every stroke a deform acts on. One stroke, or with `all_but_one`
/// every stroke reaching the baseline except the one at the far side: the
/// left and middle legs of ሓ, the middle and right legs of ሖ.
pub fn pick_all(candidates: &[(usize, Rect)], region: Region, all_but_one: bool) -> Vec<usize> {
    if !all_but_one {
        return pick(candidates, region).into_iter().collect();
    }
    let lowest = candidates.iter().map(|(_, b)| b.min.y).fold(f64::INFINITY, f64::min);
    let feet: Vec<&(usize, Rect)> =
        candidates.iter().filter(|(_, b)| b.min.y <= lowest + EDGE_TOLERANCE).collect();
    if feet.len() < 2 {
        return pick(candidates, region).into_iter().collect();
    }
    // Keep the stroke at the opposite side.
    let mirrored = match region {
        Region::BottomLeft | Region::MiddleLeft | Region::TopLeft => Region::BottomRight,
        _ => Region::BottomLeft,
    };
    let keep = pick(candidates, mirrored);
    feet.into_iter().map(|(i, _)| *i).filter(|i| Some(*i) != keep).collect()
}

/// The axis of a stroke: where it joins the body (its top middle), and the
/// unit direction to its foot (its bottom middle). For a stroke whose foot
/// is off to one side, like ለ's legs, that is its slant.
fn stroke_axis(c: &Contour, b: Rect) -> (Vec2, Vec2) {
    let h = b.max.y - b.min.y;
    let band = (h * 0.15).max(1.0);
    let mean = |pts: Vec<Vec2>| {
        let n = pts.len().max(1) as f64;
        let (x, y) = pts.iter().fold((0.0, 0.0), |(x, y), p| (x + p.x, y + p.y));
        Vec2::new(x / n, y / n)
    };
    let on: Vec<Vec2> = c.points.iter().filter(|p| p.is_on_curve()).map(|p| p.pos).collect();
    let top = mean(on.iter().copied().filter(|p| p.y >= b.max.y - band).collect());
    let bottom = mean(on.iter().copied().filter(|p| p.y <= b.min.y + band).collect());
    let (dx, dy) = (bottom.x - top.x, bottom.y - top.y);
    let n = dx.hypot(dy);
    // Nearly flat or upside down: fall back to straight down.
    if n < 1e-6 || dy > -0.3 * n {
        return (Vec2::new((b.min.x + b.max.x) / 2.0, b.max.y), Vec2::new(0.0, -1.0));
    }
    (top, Vec2::new(dx / n, dy / n))
}

/// The warp an alteration makes on `stroke`. `offset` is the family's own
/// adjustment of this deform: it moves where a short leg ends (y) and how
/// far a crick or sweep throws (x). `None` for verbs that add parts, and
/// for bend, which is not built yet.
pub fn warp_for(alt: &Alteration, stroke: &Contour, metrics: &Metrics, offset: Vec2) -> Option<Warp> {
    let b = stroke.bounds()?;
    let (lo, hi) = (b.min.y, b.max.y);
    let height = hi - lo;
    if height <= 1.0 {
        return None;
    }
    let width = (b.max.x - b.min.x).max(1.0);
    let pa = metrics.pa_height().max(1.0);
    let zone = alt.zone.as_deref().and_then(|z| metrics.zone_y(z));
    match alt.verb {
        Verb::Shorten | Verb::Lengthen => {
            let (origin, dir) = stroke_axis(stroke, b);
            let along = |p: Vec2| (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y;
            let len = stroke.points.iter().map(|p| along(p.pos)).fold(0.0, f64::max);
            // The stroke's thickness across its axis.
            let across = |p: Vec2| (p.x - origin.x) * -dir.y + (p.y - origin.y) * dir.x;
            let (amin, amax) = stroke
                .points
                .iter()
                .map(|p| across(p.pos))
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(v), b.max(v)));
            let foot = (amax - amin).min(len / 3.0).max(1.0);
            // Rising by `rise` means moving back along the axis by rise / -dir.y.
            let shift = match alt.verb {
                Verb::Shorten => {
                    let target = zone.unwrap_or(lo + height * 0.4) + offset.y;
                    // Never shorter than the foot plus as much again of shaft.
                    let rise = (target - lo).min(height - 2.0 * foot * -dir.y).max(0.0);
                    rise / -dir.y
                }
                _ => -(alt.amount.unwrap_or(pa * 0.1) + offset.y) / -dir.y,
            };
            Some(Warp::Along { origin, dir, len, foot, shift })
        }
        Verb::Crick => {
            let top = is_top(alt.placement.region);
            let default = if top { lo + height * 0.75 } else { lo + height * 0.3 };
            let z = zone.map(|z| if top { hi - (z - lo) } else { z }).unwrap_or(default);
            let z = z.clamp(lo + 1.0, hi - 1.0);
            let ramp = if top { width.min(hi - z) } else { width.min(z - lo) };
            let dx = side(alt.placement.region) * alt.amount.unwrap_or(width * 0.8) + offset.x;
            Some(Warp::Sideways { z, ramp, dx, dy: 0.0, below: !top })
        }
        Verb::Stretch => {
            // The stem's foot sweeps out and down below the baseline (ቃ ታ ፓ).
            let z = (zone.unwrap_or(lo + height * 0.45) + offset.y).clamp(lo + 1.0, hi - 1.0);
            let dx = side(alt.placement.region) * alt.amount.unwrap_or(pa * 0.12) + offset.x;
            let dy = if side(alt.placement.region) < 0.0 { pa * 0.1 } else { 0.0 };
            Some(Warp::Sideways { z, ramp: z - lo, dx, dy, below: true })
        }
        Verb::Bend | Verb::Stroke | Verb::Loop | Verb::Cap | Verb::Shoe => None,
    }
}

/// Warp a contour, first adding on-curve points where the warp bends it.
pub fn warp_contour(c: &mut Contour, warp: &Warp) {
    for y in warp.creases() {
        split_at_y(c, y);
    }
    for p in &mut c.points {
        p.pos = warp.apply(p.pos);
    }
}

fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    Vec2::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
}

fn cubic_y(s: &[Vec2; 4], t: f64) -> f64 {
    let u = 1.0 - t;
    u * u * u * s[0].y + 3.0 * u * u * t * s[1].y + 3.0 * u * t * t * s[2].y + t * t * t * s[3].y
}

/// First t in (0, 1) where the cubic crosses height `y`, away from its ends.
fn first_crossing(s: &[Vec2; 4], y: f64) -> Option<f64> {
    const STEPS: usize = 32;
    let f = |t: f64| cubic_y(s, t) - y;
    let mut prev = f(0.0);
    for i in 1..=STEPS {
        let t1 = i as f64 / STEPS as f64;
        let cur = f(t1);
        if prev * cur < 0.0 {
            let (mut a, mut b) = ((i - 1) as f64 / STEPS as f64, t1);
            for _ in 0..50 {
                let m = (a + b) / 2.0;
                if f(a) * f(m) <= 0.0 {
                    b = m;
                } else {
                    a = m;
                }
            }
            let t = (a + b) / 2.0;
            let p = split(s, t).0[3];
            let near = |q: Vec2| (p.x - q.x).hypot(p.y - q.y) < 0.5;
            let near_end = near(s[0]) || near(s[3]);
            if !near_end {
                return Some(t);
            }
        }
        prev = cur;
    }
    None
}

fn split(s: &[Vec2; 4], t: f64) -> ([Vec2; 4], [Vec2; 4]) {
    let ab = lerp(s[0], s[1], t);
    let bc = lerp(s[1], s[2], t);
    let cd = lerp(s[2], s[3], t);
    let abc = lerp(ab, bc, t);
    let bcd = lerp(bc, cd, t);
    let m = lerp(abc, bcd, t);
    ([s[0], ab, abc, m], [m, bcd, cd, s[3]])
}

/// Split every segment of `c` where it crosses height `y`, adding on-curve
/// points (with new ids) and leaving the shape unchanged.
pub fn split_at_y(c: &mut Contour, y: f64) {
    let n = c.points.len();
    let Some(start) = c.points.iter().position(Point::is_on_curve) else {
        return;
    };
    let mut next_id = c.points.iter().map(|p| p.id).max().unwrap_or(0) + 1;
    let mut fresh = || {
        next_id += 1;
        next_id - 1
    };
    let mut out: Vec<Point> = vec![c.points[start].clone()];
    let mut prev = c.points[start].pos;
    let mut handles: Vec<Point> = Vec::new();
    for i in 1..=n {
        let p = c.points[(start + i) % n].clone();
        if p.kind == PointKind::OffCurve {
            handles.push(p);
            continue;
        }
        let closing = i == n;
        if handles.len() == 2 {
            let mut seg = [prev, handles[0].pos, handles[1].pos, p.pos];
            let mut ids = [handles[0].id, handles[1].id];
            while let Some(t) = first_crossing(&seg, y) {
                let (a, b) = split(&seg, t);
                out.push(Point { pos: a[1], ..handles[0].clone() });
                out.last_mut().unwrap().id = ids[0];
                out.push(Point { pos: a[2], ..handles[1].clone() });
                out.last_mut().unwrap().id = ids[1];
                out.push(Point { id: fresh(), pos: a[3], kind: PointKind::Curve, smooth: true });
                ids = [fresh(), fresh()];
                seg = b;
            }
            out.push(Point { id: ids[0], pos: seg[1], ..handles[0].clone() });
            out.push(Point { id: ids[1], pos: seg[2], ..handles[1].clone() });
        } else {
            let (a, b) = (prev, p.pos);
            if (a.y - y) * (b.y - y) < 0.0 && (a.y - y).abs() > 0.5 && (b.y - y).abs() > 0.5 {
                let t = (y - a.y) / (b.y - a.y);
                out.push(Point { id: fresh(), pos: lerp(a, b, t), kind: PointKind::Line, smooth: false });
            }
            out.extend(handles.iter().cloned());
        }
        handles.clear();
        if !closing {
            out.push(p.clone());
        }
        prev = p.pos;
    }
    c.points = out;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alteration::Placement;
    use crate::parts::Part;

    fn alt(verb: Verb, region: Region, zone: Option<&str>) -> Alteration {
        Alteration {
            id: "x".into(),
            name: "x".into(),
            verb,
            placement: Placement { anchor: None, region, parts: vec![Part::Leg], offset: Vec2::ZERO },
            contours: vec![],
            forked_from: None,
            zone: zone.map(String::from),
            amount: None,
            all_but_one: false,
        }
    }

    fn leg() -> Contour {
        Contour::rect(0, Some(Part::Leg), Vec2::new(400.0, 0.0), Vec2::new(460.0, 700.0))
    }

    #[test]
    fn shorten_ends_the_leg_on_its_zone() {
        let m = Metrics::default();
        let mut c = leg();
        let w = warp_for(&alt(Verb::Shorten, Region::BottomRight, Some("short-leg")), &c, &m, Vec2::ZERO);
        warp_contour(&mut c, &w.unwrap());
        let b = c.bounds().unwrap();
        assert!((b.min.y - 280.0).abs() < 1e-9, "{b:?}");
        assert_eq!(b.max.y, 700.0);
        assert_eq!(c.validate(), Ok(()));
        // The family's own offset moves the end.
        let mut c = leg();
        let w = warp_for(
            &alt(Verb::Shorten, Region::BottomRight, Some("short-leg")),
            &c,
            &m,
            Vec2::new(0.0, 50.0),
        );
        warp_contour(&mut c, &w.unwrap());
        assert!((c.bounds().unwrap().min.y - 330.0).abs() < 1e-9);
    }

    #[test]
    fn a_slanted_leg_keeps_its_slope() {
        // ለ's left leg: from the apex at (300, 700) down to the foot at (0, 0).
        let mut c = Contour::new(
            0,
            Some(Part::Leg),
            vec![
                Point::line(0, 260.0, 700.0),
                Point::line(1, 340.0, 700.0),
                Point::line(2, 80.0, 0.0),
                Point::line(3, 0.0, 0.0),
            ],
        );
        let slope = |c: &Contour| {
            let (a, b) = (c.points[0].pos, c.points[3].pos);
            (a.x - b.x) / (a.y - b.y)
        };
        let before = slope(&c);
        let m = Metrics::default();
        let w =
            warp_for(&alt(Verb::Shorten, Region::BottomLeft, Some("short-leg")), &c, &m, Vec2::ZERO).unwrap();
        warp_contour(&mut c, &w);
        assert!((c.bounds().unwrap().min.y - 280.0).abs() < 1e-6, "{:?}", c.bounds());
        assert!((slope(&c) - before).abs() < 1e-9);
        // The foot moved up the leg, so it moved right too.
        assert!(c.points[3].pos.x > 100.0);
        // Thickness across the bottom is unchanged.
        assert!(((c.points[2].pos.x - c.points[3].pos.x) - 80.0).abs() < 1e-9);
    }

    #[test]
    fn shorten_keeps_the_foot_shape() {
        // A leg with a curved foot: the foot moves up whole.
        let mut c = Contour::new(
            0,
            Some(Part::Leg),
            vec![
                Point::line(0, 460.0, 700.0),
                Point::line(1, 400.0, 700.0),
                Point::line(2, 400.0, 40.0),
                Point::off(3, 400.0, 10.0),
                Point::off(4, 420.0, 0.0),
                Point::curve(5, 440.0, 0.0),
                Point::line(6, 460.0, 40.0),
            ],
        );
        let before: Vec<Vec2> = c.points[2..6].iter().map(|p| p.pos).collect();
        let w = Warp::Along {
            origin: Vec2::new(430.0, 700.0),
            dir: Vec2::new(0.0, -1.0),
            len: 700.0,
            foot: 60.0,
            shift: 200.0,
        };
        warp_contour(&mut c, &w);
        for (p, q) in c.points[2..6].iter().zip(before) {
            assert!((p.pos.y - (q.y + 200.0)).abs() < 1e-9 && (p.pos.x - q.x).abs() < 1e-9);
        }
        assert_eq!(c.points[0].pos.y, 700.0);
    }

    #[test]
    fn foot_flick_kinks_the_foot_left_at_its_zone() {
        let m = Metrics::default();
        let mut c = leg();
        let w = warp_for(&alt(Verb::Crick, Region::BottomLeft, Some("crick")), &c, &m, Vec2::ZERO).unwrap();
        warp_contour(&mut c, &w);
        assert_eq!(c.validate(), Ok(()));
        // The rectangle gained two points on each side: at the zone and at
        // the end of the ramp.
        assert_eq!(c.points.len(), 8);
        let at = |y: f64| {
            c.points.iter().filter(|p| (p.pos.y - y).abs() < 1e-6).map(|p| p.pos.x).collect::<Vec<_>>()
        };
        let mut top = at(210.0);
        top.sort_by(f64::total_cmp);
        assert_eq!(top, vec![400.0, 460.0]);
        let mut bottom = at(0.0);
        bottom.sort_by(f64::total_cmp);
        assert_eq!(bottom, vec![352.0, 412.0]);
    }

    #[test]
    fn crick_at_the_top_bends_the_head_left() {
        let m = Metrics::default();
        let mut c = leg();
        let w = warp_for(&alt(Verb::Crick, Region::TopLeft, None), &c, &m, Vec2::ZERO).unwrap();
        warp_contour(&mut c, &w);
        let b = c.bounds().unwrap();
        assert!(b.min.x < 400.0);
        // The foot stays where it was.
        let foot: Vec<f64> = c.points.iter().filter(|p| p.pos.y == 0.0).map(|p| p.pos.x).collect();
        assert!(foot.iter().all(|x| *x == 400.0 || *x == 460.0));
    }

    #[test]
    fn stem_sweeps_left_under_the_baseline() {
        let m = Metrics::default();
        let mut c = leg();
        let w =
            warp_for(&alt(Verb::Stretch, Region::BottomLeft, Some("stretch")), &c, &m, Vec2::ZERO).unwrap();
        warp_contour(&mut c, &w);
        let b = c.bounds().unwrap();
        assert!((b.min.x - (400.0 - 84.0)).abs() < 1e-9, "{b:?}");
        assert!((b.min.y + 70.0).abs() < 1e-9, "{b:?}");
    }

    #[test]
    fn splits_curves_without_changing_them() {
        let mut c = Contour::new(
            0,
            None,
            vec![
                Point::curve(0, 0.0, 0.0),
                Point::off(1, 55.0, 0.0),
                Point::off(2, 100.0, 45.0),
                Point::curve(3, 100.0, 100.0),
                Point::line(4, 0.0, 100.0),
            ],
        );
        c.points[0].kind = PointKind::Line;
        split_at_y(&mut c, 50.0);
        assert_eq!(c.validate(), Ok(()));
        // The curve gains a point and two handles, the closing line a point.
        assert_eq!(c.points.len(), 9);
        let m = c.points.iter().find(|p| p.kind == PointKind::Curve && (p.pos.y - 50.0).abs() < 1e-6);
        assert!(m.is_some());
        let ids: std::collections::HashSet<u32> = c.points.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), c.points.len());
    }

    #[test]
    fn picks_the_lowest_leg_on_the_side() {
        let r = |x0: f64, y0: f64, x1: f64| Rect { min: Vec2::new(x0, y0), max: Vec2::new(x1, 700.0) };
        let c = [(0, r(50.0, 0.0, 110.0)), (1, r(400.0, 0.0, 460.0)), (2, r(500.0, 300.0, 540.0))];
        assert_eq!(pick(&c, Region::BottomLeft), Some(0));
        assert_eq!(pick(&c, Region::BottomRight), Some(1));
        assert_eq!(pick(&c, Region::TopRight), Some(2));
        // ሓ: every leg on the baseline but the right one; ሖ: but the left one.
        let three = [(0, r(50.0, 0.0, 110.0)), (1, r(250.0, 0.0, 310.0)), (2, r(400.0, 0.0, 460.0))];
        assert_eq!(pick_all(&three, Region::BottomLeft, true), vec![0, 1]);
        assert_eq!(pick_all(&three, Region::BottomRight, true), vec![1, 2]);
        assert_eq!(pick_all(&three, Region::BottomRight, false), vec![2]);
    }
}
