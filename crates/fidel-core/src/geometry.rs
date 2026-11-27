//! Outline geometry. Closed cubic Bézier contours using the same point model as
//! UFO (on-curve `line`/`curve` points and `offcurve` handles), so nothing is
//! lost when flattening to UFO or OpenType.
//!
//! Every point and contour carries a stable id. Glyph overrides ("nudges") point
//! at these ids, which is what lets an Adjusted fidel keep its edits after the
//! base or alteration it was generated from changes.

use serde::{Deserialize, Serialize};
use std::ops::{Add, AddAssign, Sub};

use crate::parts::Part;

/// Stable id of a point, unique within its contour.
pub type PointId = u32;
/// Stable id of a contour, unique within its drawing (a base, an alteration, or
/// a hand-drawn fidel).
pub type ContourId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Vec2 { x, y }
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }
}

impl AddAssign for Vec2 {
    fn add_assign(&mut self, o: Vec2) {
        self.x += o.x;
        self.y += o.y;
    }
}

impl std::ops::Mul<f64> for Vec2 {
    type Output = Vec2;
    fn mul(self, k: f64) -> Vec2 {
        Vec2::new(self.x * k, self.y * k)
    }
}

impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PointKind {
    /// On-curve point reached by a straight segment.
    Line,
    /// On-curve point reached by a cubic segment (preceded by two off-curves).
    Curve,
    /// Cubic handle.
    OffCurve,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub id: PointId,
    pub pos: Vec2,
    pub kind: PointKind,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub smooth: bool,
}

impl Point {
    pub fn line(id: PointId, x: f64, y: f64) -> Self {
        Point { id, pos: Vec2::new(x, y), kind: PointKind::Line, smooth: false }
    }
    pub fn curve(id: PointId, x: f64, y: f64) -> Self {
        Point { id, pos: Vec2::new(x, y), kind: PointKind::Curve, smooth: true }
    }
    pub fn off(id: PointId, x: f64, y: f64) -> Self {
        Point { id, pos: Vec2::new(x, y), kind: PointKind::OffCurve, smooth: false }
    }
    pub fn is_on_curve(&self) -> bool {
        self.kind != PointKind::OffCurve
    }
}

/// A closed contour, optionally tagged with the part of the letter it draws
/// (stem, leg, ring ...), following Hornus's morphology.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Contour {
    pub id: ContourId,
    pub points: Vec<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<Part>,
    /// A layer name, e.g. the alteration a detached contour came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Locked in the editor: drawn, but cannot be selected by mistake.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    /// Hidden in the editor. Still part of the glyph and still exported.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// An open path: it starts and ends on its first and last points, with no
    /// closing segment. Kept while drawing; not exported.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub open: bool,
}

impl Contour {
    pub fn new(id: ContourId, part: Option<Part>, points: Vec<Point>) -> Self {
        Contour { id, points, part, name: None, locked: false, hidden: false, open: false }
    }

    /// Axis-aligned rectangle with corners at `min` and `max`, drawn
    /// counter-clockwise. Handy for tests and placeholder drawings.
    pub fn rect(id: ContourId, part: Option<Part>, min: Vec2, max: Vec2) -> Self {
        Contour::new(
            id,
            part,
            vec![
                Point::line(0, min.x, min.y),
                Point::line(1, max.x, min.y),
                Point::line(2, max.x, max.y),
                Point::line(3, min.x, max.y),
            ],
        )
    }

    /// Control-point bounds. Slightly larger than the true curve bounds when
    /// handles stick out, which is fine for placement.
    pub fn bounds(&self) -> Option<Rect> {
        Rect::enclosing(self.points.iter().map(|p| p.pos))
    }

    pub fn translate(&mut self, d: Vec2) {
        for p in &mut self.points {
            p.pos += d;
        }
    }

    pub fn point_mut(&mut self, id: PointId) -> Option<&mut Point> {
        self.points.iter_mut().find(|p| p.id == id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub min: Vec2,
    pub max: Vec2,
}

impl Rect {
    pub fn enclosing(points: impl IntoIterator<Item = Vec2>) -> Option<Rect> {
        let mut it = points.into_iter();
        let first = it.next()?;
        let mut r = Rect { min: first, max: first };
        for p in it {
            r.min.x = r.min.x.min(p.x);
            r.min.y = r.min.y.min(p.y);
            r.max.x = r.max.x.max(p.x);
            r.max.y = r.max.y.max(p.y);
        }
        Some(r)
    }

    pub fn union(self, o: Rect) -> Rect {
        Rect {
            min: Vec2::new(self.min.x.min(o.min.x), self.min.y.min(o.min.y)),
            max: Vec2::new(self.max.x.max(o.max.x), self.max.y.max(o.max.y)),
        }
    }

    pub fn center(&self) -> Vec2 {
        Vec2::new((self.min.x + self.max.x) / 2.0, (self.min.y + self.max.y) / 2.0)
    }
}

/// Bounds of a set of contours.
pub fn bounds_of<'a>(contours: impl IntoIterator<Item = &'a Contour>) -> Option<Rect> {
    contours.into_iter().filter_map(Contour::bounds).reduce(Rect::union)
}

/// Why a contour is not a valid closed cubic contour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContourProblem {
    NoOnCurvePoint,
    TooFewPoints,
    DuplicatePointId(PointId),
    /// More than two handles in a row.
    TooManyHandles,
    /// Handles followed by a `line` point instead of a `curve` point.
    HandlesBeforeLine,
    /// A `curve` point without the two handles in front of it.
    CurveWithoutHandles,
    /// An open path that starts or ends on a handle.
    OpenEndsOffCurve,
}

impl Contour {
    /// Check that the points form a cubic contour in UFO order: each
    /// `curve` point is preceded by exactly two handles, each `line` point by none.
    pub fn validate(&self) -> Result<(), ContourProblem> {
        let n = self.points.len();
        if n < 2 {
            return Err(ContourProblem::TooFewPoints);
        }
        let mut seen = std::collections::HashSet::new();
        for p in &self.points {
            if !seen.insert(p.id) {
                return Err(ContourProblem::DuplicatePointId(p.id));
            }
        }
        let start = self.points.iter().position(Point::is_on_curve).ok_or(ContourProblem::NoOnCurvePoint)?;
        if self.open && (start != 0 || !self.points[n - 1].is_on_curve()) {
            return Err(ContourProblem::OpenEndsOffCurve);
        }
        let mut handles = 0;
        let steps = if self.open { n - 1 } else { n };
        for i in 1..=steps {
            let p = &self.points[(start + i) % n];
            match p.kind {
                PointKind::OffCurve => {
                    handles += 1;
                    if handles > 2 {
                        return Err(ContourProblem::TooManyHandles);
                    }
                }
                PointKind::Line if handles > 0 => return Err(ContourProblem::HandlesBeforeLine),
                PointKind::Curve if handles != 2 => return Err(ContourProblem::CurveWithoutHandles),
                _ => handles = 0,
            }
        }
        Ok(())
    }

    /// SVG path data in font units (y up). Assumes a valid contour.
    pub fn to_svg_path(&self) -> String {
        let n = self.points.len();
        let Some(start) = self.points.iter().position(Point::is_on_curve) else {
            return String::new();
        };
        let f = |v: f64| {
            let r = (v * 100.0).round() / 100.0;
            if r == r.trunc() {
                format!("{}", r as i64)
            } else {
                format!("{r}")
            }
        };
        let first = &self.points[start];
        let mut d = format!("M{} {}", f(first.pos.x), f(first.pos.y));
        let mut pending: Vec<Vec2> = Vec::new();
        let steps = if self.open { n - 1 } else { n };
        for i in 1..=steps {
            let p = &self.points[(start + i) % n];
            match p.kind {
                PointKind::OffCurve => pending.push(p.pos),
                PointKind::Curve if pending.len() == 2 => {
                    d += &format!(
                        "C{} {} {} {} {} {}",
                        f(pending[0].x),
                        f(pending[0].y),
                        f(pending[1].x),
                        f(pending[1].y),
                        f(p.pos.x),
                        f(p.pos.y)
                    );
                    pending.clear();
                }
                _ => {
                    if i < n || self.open {
                        d += &format!("L{} {}", f(p.pos.x), f(p.pos.y));
                    }
                    pending.clear();
                }
            }
        }
        if !self.open {
            d.push('Z');
        }
        d
    }
}

/// SVG path data for several contours.
pub fn svg_path<'a>(contours: impl IntoIterator<Item = &'a Contour>) -> String {
    contours.into_iter().map(Contour::to_svg_path).collect::<Vec<_>>().join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circle_ish() -> Contour {
        Contour::new(
            0,
            None,
            vec![
                Point::curve(0, 100.0, 0.0),
                Point::off(1, 155.0, 0.0),
                Point::off(2, 200.0, 45.0),
                Point::curve(3, 200.0, 100.0),
                Point::off(4, 200.0, 155.0),
                Point::off(5, 155.0, 200.0),
                Point::curve(6, 100.0, 200.0),
                Point::line(7, 0.0, 100.0),
                Point::off(8, 0.0, 45.0),
                Point::off(9, 45.0, 0.0),
            ],
        )
    }

    #[test]
    fn validates_ufo_point_order() {
        assert_eq!(circle_ish().validate(), Ok(()));
        assert_eq!(Contour::rect(0, None, Vec2::ZERO, Vec2::new(1.0, 1.0)).validate(), Ok(()));

        let mut c = circle_ish();
        c.points[1].id = 0;
        assert_eq!(c.validate(), Err(ContourProblem::DuplicatePointId(0)));

        let mut c = circle_ish();
        c.points[3].kind = PointKind::Line;
        assert_eq!(c.validate(), Err(ContourProblem::HandlesBeforeLine));

        let mut c = circle_ish();
        c.points.remove(1);
        assert_eq!(c.validate(), Err(ContourProblem::CurveWithoutHandles));

        let c = Contour::new(0, None, vec![Point::off(0, 0.0, 0.0), Point::off(1, 1.0, 1.0)]);
        assert_eq!(c.validate(), Err(ContourProblem::NoOnCurvePoint));
    }

    #[test]
    fn open_paths_validate_and_draw_without_closing() {
        let mut c = Contour::new(
            0,
            None,
            vec![Point::line(0, 0.0, 0.0), Point::line(1, 100.0, 0.0), Point::line(2, 100.0, 100.0)],
        );
        c.open = true;
        assert_eq!(c.validate(), Ok(()));
        assert_eq!(c.to_svg_path(), "M0 0L100 0L100 100");
        // An open path cannot end on a handle.
        c.points.push(Point::off(3, 50.0, 50.0));
        assert_eq!(c.validate(), Err(ContourProblem::OpenEndsOffCurve));
    }

    #[test]
    fn svg_path_wraps_the_closing_curve() {
        assert_eq!(
            circle_ish().to_svg_path(),
            "M100 0C155 0 200 45 200 100C200 155 155 200 100 200L0 100C0 45 45 0 100 0Z"
        );
        let r = Contour::rect(0, None, Vec2::ZERO, Vec2::new(10.5, 20.0));
        assert_eq!(r.to_svg_path(), "M0 0L10.5 0L10.5 20L0 20Z");
    }
}
