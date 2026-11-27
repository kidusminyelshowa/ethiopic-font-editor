//! Adding points so two versions of a contour match point for point.
//!
//! Points are only ever added, never taken away, so neither outline changes
//! shape: the one with fewer segments is split where the other has a point
//! (by distance along the outline), and a straight segment facing a curve
//! becomes a curve with its handles a third of the way along.

use crate::geometry::{Contour, Point, PointId, PointKind, Vec2};

#[derive(Debug, Clone)]
struct Seg {
    handles: Option<(Vec2, Vec2)>,
    end: Point,
}

#[derive(Debug, Clone)]
struct Segs {
    /// An open path's first point; a closed one starts at its last segment's end.
    start: Option<Point>,
    segs: Vec<Seg>,
}

fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    a + (b - a) * t
}

fn split_segments(c: &Contour) -> Option<Segs> {
    let mut pts = c.points.clone();
    if pts.iter().all(|p| !p.is_on_curve()) {
        return None;
    }
    let mut start = None;
    if c.open {
        let first = pts.remove(0);
        if !first.is_on_curve() {
            return None;
        }
        start = Some(first);
    } else {
        let k = pts.iter().position(Point::is_on_curve)?;
        pts.rotate_left(k);
        // The first point closes the contour: its handles are at the end.
        let first = pts.remove(0);
        pts.push(first);
    }
    let mut segs = Vec::new();
    let mut pending: Vec<Vec2> = Vec::new();
    for p in pts {
        if p.kind == PointKind::OffCurve {
            pending.push(p.pos);
            continue;
        }
        let handles = match pending.len() {
            0 => None,
            2 => Some((pending[0], pending[1])),
            _ => return None,
        };
        pending.clear();
        segs.push(Seg { handles, end: p });
    }
    if !pending.is_empty() || segs.is_empty() {
        return None;
    }
    Some(Segs { start, segs })
}

impl Segs {
    fn start_of(&self, k: usize) -> Vec2 {
        if k == 0 {
            match &self.start {
                Some(p) => p.pos,
                None => self.segs[self.segs.len() - 1].end.pos,
            }
        } else {
            self.segs[k - 1].end.pos
        }
    }

    fn at(&self, k: usize, t: f64) -> Vec2 {
        let p0 = self.start_of(k);
        let s = &self.segs[k];
        match s.handles {
            None => lerp(p0, s.end.pos, t),
            Some((c1, c2)) => {
                let u = 1.0 - t;
                p0 * (u * u * u) + c1 * (3.0 * u * u * t) + c2 * (3.0 * u * t * t) + s.end.pos * (t * t * t)
            }
        }
    }

    /// Lengths along segment `k` at `n + 1` evenly spaced parameters.
    fn lengths(&self, k: usize, n: usize) -> Vec<f64> {
        let mut out = vec![0.0];
        let mut prev = self.at(k, 0.0);
        let mut total = 0.0;
        for i in 1..=n {
            let p = self.at(k, i as f64 / n as f64);
            let d = p - prev;
            total += d.x.hypot(d.y);
            out.push(total);
            prev = p;
        }
        out
    }

    /// Where each segment ends, as a share of the whole length.
    fn ends(&self) -> Vec<f64> {
        let lens: Vec<f64> = (0..self.segs.len()).map(|k| *self.lengths(k, 16).last().unwrap()).collect();
        let total: f64 = lens.iter().sum::<f64>().max(1e-9);
        let mut acc = 0.0;
        lens.iter()
            .map(|l| {
                acc += l;
                acc / total
            })
            .collect()
    }

    /// Split at `u`, a share of the whole length.
    fn split_at(&mut self, u: f64, next_id: &mut PointId) {
        let ends = self.ends();
        let k = ends.iter().position(|&e| e > u).unwrap_or(ends.len() - 1);
        let a = if k == 0 { 0.0 } else { ends[k - 1] };
        let f = ((u - a) / (ends[k] - a).max(1e-9)).clamp(0.0, 1.0);
        // The parameter that far along the segment.
        let n = 64;
        let ls = self.lengths(k, n);
        let goal = f * ls[n];
        let i = ls.iter().position(|&l| l >= goal).unwrap_or(n).max(1);
        let span = (ls[i] - ls[i - 1]).max(1e-9);
        let t = ((i - 1) as f64 + (goal - ls[i - 1]) / span) / n as f64;

        let p0 = self.start_of(k);
        let s = self.segs[k].clone();
        let id = *next_id;
        *next_id += 1;
        let (first, second) = match s.handles {
            None => {
                let m = lerp(p0, s.end.pos, t);
                (Seg { handles: None, end: Point { id, pos: m, kind: PointKind::Line, smooth: false } }, s)
            }
            Some((c1, c2)) => {
                let (a1, b1, c) = (lerp(p0, c1, t), lerp(c1, c2, t), lerp(c2, s.end.pos, t));
                let (a2, b2) = (lerp(a1, b1, t), lerp(b1, c, t));
                let m = lerp(a2, b2, t);
                (
                    Seg {
                        handles: Some((a1, a2)),
                        end: Point { id, pos: m, kind: PointKind::Curve, smooth: true },
                    },
                    Seg { handles: Some((b2, c)), end: s.end },
                )
            }
        };
        self.segs[k] = second;
        self.segs.insert(k, first);
    }

    /// A straight segment as a curve with the same course.
    fn curve(&mut self, k: usize) {
        let p0 = self.start_of(k);
        let s = &mut self.segs[k];
        if s.handles.is_none() {
            s.handles = Some((lerp(p0, s.end.pos, 1.0 / 3.0), lerp(p0, s.end.pos, 2.0 / 3.0)));
            s.end.kind = PointKind::Curve;
        }
    }

    fn to_points(&self, next_id: &mut PointId) -> Vec<Point> {
        let mut out = Vec::new();
        let off = |pos: Vec2, next_id: &mut PointId| {
            let id = *next_id;
            *next_id += 1;
            Point { id, pos, kind: PointKind::OffCurve, smooth: false }
        };
        let n = self.segs.len();
        let (head, body): (Point, &[Seg]) = match &self.start {
            Some(p) => (p.clone(), &self.segs[..]),
            None => (self.segs[n - 1].end.clone(), &self.segs[..n - 1]),
        };
        out.push(head);
        for s in body {
            if let Some((a, b)) = s.handles {
                out.push(off(a, next_id));
                out.push(off(b, next_id));
            }
            out.push(s.end.clone());
        }
        if self.start.is_none() {
            if let Some((a, b)) = self.segs[n - 1].handles {
                out.push(off(a, next_id));
                out.push(off(b, next_id));
            }
        }
        out
    }
}

/// Add points to `a` and `b`, two versions of one contour that already run
/// the same way from matching starts, until they match point for point.
/// None when they cannot be read as segments, or are one open, one closed.
pub fn add_points_to_match(a: &Contour, b: &Contour) -> Option<(Contour, Contour)> {
    if a.open != b.open {
        return None;
    }
    let (mut sa, mut sb) = (split_segments(a)?, split_segments(b)?);
    let max_id = |c: &Contour| c.points.iter().map(|p| p.id).max().unwrap_or(0) + 1;
    let (mut ida, mut idb) = (max_id(a), max_id(b));
    let (mut touched_a, mut touched_b) = (false, false);
    let mut guard = 0;
    while sa.segs.len() != sb.segs.len() && guard < 500 {
        guard += 1;
        let (few, many, id) = if sa.segs.len() < sb.segs.len() {
            touched_a = true;
            (&mut sa, &sb, &mut ida)
        } else {
            touched_b = true;
            (&mut sb, &sa, &mut idb)
        };
        let have = few.ends();
        let want = many.ends();
        // The other's point furthest from any of these.
        let far = want[..want.len() - 1]
            .iter()
            .map(|&u| (u, have.iter().chain([&0.0]).map(|&h| (h - u).abs()).fold(f64::INFINITY, f64::min)))
            .max_by(|x, y| x.1.total_cmp(&y.1))?;
        few.split_at(far.0, id);
    }
    if sa.segs.len() != sb.segs.len() {
        return None;
    }
    for k in 0..sa.segs.len() {
        if sa.segs[k].handles.is_some() != sb.segs[k].handles.is_some() {
            touched_a |= sa.segs[k].handles.is_none();
            touched_b |= sb.segs[k].handles.is_none();
            sa.curve(k);
            sb.curve(k);
        }
    }
    let mut ca = a.clone();
    if touched_a {
        ca.points = sa.to_points(&mut ida);
    }
    let mut cb = b.clone();
    if touched_b {
        cb.points = sb.to_points(&mut idb);
    }
    Some((ca, cb))
}

/// Turn a closed contour so its first on-curve point is the one nearest
/// `start`, measured from each contour's middle.
pub fn start_near(c: &mut Contour, start: Vec2, reference_center: Vec2) {
    if c.open || c.points.is_empty() {
        return;
    }
    let cc = c.bounds().map(|r| r.center()).unwrap_or_default();
    let want = start - reference_center;
    let best = (0..c.points.len()).filter(|&k| c.points[k].is_on_curve()).min_by(|&x, &y| {
        let d = |k: usize| {
            let v = (c.points[k].pos - cc) - want;
            v.x.hypot(v.y)
        };
        d(x).total_cmp(&d(y))
    });
    if let Some(k) = best {
        c.points.rotate_left(k);
    }
}
