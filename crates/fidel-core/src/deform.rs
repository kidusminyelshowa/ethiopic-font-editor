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
    /// Move the foot (everything below `lo + foot`) up by `shift` and stretch
    /// or squash the shaft between it and `hi` to match.
    Vertical { lo: f64, foot: f64, hi: f64, shift: f64 },
    /// Push everything below `z` sideways: nothing at `z`, ramping to `dx` at
    /// `z - ramp` and constant below.
    Sideways { z: f64, ramp: f64, dx: f64 },
}

impl Warp {
    pub fn apply(&self, p: Vec2) -> Vec2 {
        match *self {
            Warp::Vertical { lo, foot, hi, shift } => {
                let knee = lo + foot;
                let y = if p.y <= knee || hi - knee < 1e-9 {
                    p.y + shift
                } else {
                    let k = (hi - (knee + shift)) / (hi - knee);
                    knee + shift + (p.y - knee) * k
                };
                Vec2::new(p.x, y)
            }
            Warp::Sideways { z, ramp, dx } => {
                let t = if p.y >= z {
                    0.0
                } else if ramp <= 1e-9 || p.y <= z - ramp {
                    1.0
                } else {
                    (z - p.y) / ramp
                };
                Vec2::new(p.x + dx * t, p.y)
            }
        }
    }

    /// Heights where the stroke needs an on-curve point for the warp to bend
    /// it in the right place.
    fn creases(&self) -> Vec<f64> {
        match *self {
            Warp::Vertical { .. } => Vec::new(),
            Warp::Sideways { z, ramp, .. } => vec![z, z - ramp],
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

/// The warp an alteration makes on a stroke with bounds `b`. `None` for verbs
/// that add parts, and for bend, which is not built yet.
pub fn warp_for(alt: &Alteration, b: Rect, metrics: &Metrics) -> Option<Warp> {
    let (lo, hi) = (b.min.y, b.max.y);
    let height = hi - lo;
    if height <= 1.0 {
        return None;
    }
    let width = (b.max.x - b.min.x).max(1.0);
    let pa = metrics.pa_height().max(1.0);
    let zone = alt.zone.as_deref().and_then(|z| metrics.zone_y(z));
    let foot = width.min(height / 3.0);
    match alt.verb {
        Verb::Shorten | Verb::Lengthen => {
            let target = match alt.verb {
                Verb::Shorten => zone.unwrap_or(lo + height * 0.4),
                _ => lo - alt.amount.unwrap_or(pa * 0.1),
            };
            // Never shorter than the foot plus as much again of shaft.
            let target = target.min(hi - 2.0 * foot);
            Some(Warp::Vertical { lo, foot, hi, shift: target - lo })
        }
        Verb::Crick => {
            let z = zone.unwrap_or(lo + height * 0.3).clamp(lo + 1.0, hi - 1.0);
            let ramp = width.min(z - lo);
            let dx = side(alt.placement.region) * alt.amount.unwrap_or(width * 0.8);
            Some(Warp::Sideways { z, ramp, dx })
        }
        Verb::Stretch => {
            let z = zone.unwrap_or(lo + height * 0.45).clamp(lo + 1.0, hi - 1.0);
            let dx = side(alt.placement.region) * alt.amount.unwrap_or(pa * 0.12);
            Some(Warp::Sideways { z, ramp: z - lo, dx })
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
        }
    }

    fn leg() -> Contour {
        Contour::rect(0, Some(Part::Leg), Vec2::new(400.0, 0.0), Vec2::new(460.0, 700.0))
    }

    #[test]
    fn shorten_ends_the_leg_on_its_zone() {
        let m = Metrics::default();
        let mut c = leg();
        let w =
            warp_for(&alt(Verb::Shorten, Region::BottomRight, Some("short-leg")), c.bounds().unwrap(), &m);
        warp_contour(&mut c, &w.unwrap());
        let b = c.bounds().unwrap();
        assert!((b.min.y - 280.0).abs() < 1e-9, "{b:?}");
        assert_eq!(b.max.y, 700.0);
        assert_eq!(c.validate(), Ok(()));
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
        let w = Warp::Vertical { lo: 0.0, foot: 60.0, hi: 700.0, shift: 200.0 };
        warp_contour(&mut c, &w);
        for (p, q) in c.points[2..6].iter().zip(before) {
            assert_eq!(p.pos, Vec2::new(q.x, q.y + 200.0));
        }
        assert_eq!(c.points[0].pos.y, 700.0);
    }

    #[test]
    fn crick_kinks_the_foot_left_at_its_zone() {
        let m = Metrics::default();
        let mut c = leg();
        let w =
            warp_for(&alt(Verb::Crick, Region::BottomLeft, Some("crick")), c.bounds().unwrap(), &m).unwrap();
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
    fn stretch_leans_the_stroke_out() {
        let m = Metrics::default();
        let mut c = leg();
        let w = warp_for(&alt(Verb::Stretch, Region::BottomRight, Some("stretch")), c.bounds().unwrap(), &m)
            .unwrap();
        warp_contour(&mut c, &w);
        let b = c.bounds().unwrap();
        assert!((b.max.x - (460.0 + 84.0)).abs() < 1e-9, "{b:?}");
        assert_eq!(b.min.y, 0.0);
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
    }
}
