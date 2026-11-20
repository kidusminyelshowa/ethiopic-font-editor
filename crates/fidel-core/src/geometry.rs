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
}

impl Contour {
    pub fn new(id: ContourId, part: Option<Part>, points: Vec<Point>) -> Self {
        Contour { id, points, part }
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
