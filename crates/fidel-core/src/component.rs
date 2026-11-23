//! Components: a leaf, cap or corner drawn once and placed on any base.
//! Hornus's leafs are the Ethiopic counterpart of serifs; drawing them once
//! keeps every terminal in the font the same.

use serde::{Deserialize, Serialize};

use crate::geometry::{Contour, ContourId, PointKind, Vec2};

pub type ComponentId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentKind {
    /// The terminal at the end of a bar or branch.
    Leaf,
    /// The end of an open stroke.
    Cap,
    /// An inner or outer corner.
    Corner,
}

/// A shape drawn once, with the point where it joins the letter at the
/// origin (0, 0).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Component {
    pub id: ComponentId,
    pub name: String,
    pub kind: ComponentKind,
    #[serde(default)]
    pub contours: Vec<Contour>,
}

/// One placement of a component on a base.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentRef {
    /// Unique within the base. Nudges on a generated fidel find the placed
    /// contours by it.
    pub id: u32,
    pub component: ComponentId,
    /// Where the component's origin goes.
    pub at: Vec2,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub scale: f64,
    /// Degrees, counter-clockwise.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rotate: f64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flip_x: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flip_y: bool,
    /// The base contour this placement sits on. When a deform moves that
    /// contour (a shortened leg, a crick), the component moves with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<ContourId>,
}

fn one() -> f64 {
    1.0
}
fn is_one(v: &f64) -> bool {
    *v == 1.0
}
fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

impl ComponentRef {
    pub fn new(id: u32, component: impl Into<ComponentId>, at: Vec2) -> Self {
        ComponentRef {
            id,
            component: component.into(),
            at,
            scale: 1.0,
            rotate: 0.0,
            flip_x: false,
            flip_y: false,
            on: None,
        }
    }

    /// Map a point of the component's drawing into the base.
    pub fn apply(&self, p: Vec2) -> Vec2 {
        let sx = if self.flip_x { -self.scale } else { self.scale };
        let sy = if self.flip_y { -self.scale } else { self.scale };
        let (x, y) = (p.x * sx, p.y * sy);
        let (s, c) = self.rotate.to_radians().sin_cos();
        Vec2::new(x * c - y * s + self.at.x, x * s + y * c + self.at.y)
    }

    /// The component's contours, placed. Mirrored placements are reversed so
    /// path direction stays right.
    pub fn place(&self, component: &Component) -> Vec<Contour> {
        let mirrored = self.flip_x != self.flip_y;
        component
            .contours
            .iter()
            .map(|c| {
                let mut c = c.clone();
                for p in &mut c.points {
                    p.pos = self.apply(p.pos);
                }
                if mirrored {
                    reverse(&mut c);
                }
                c
            })
            .collect()
    }
}

/// Reverse a contour's direction, keeping each segment's type.
pub fn reverse(c: &mut Contour) {
    let n = c.points.len();
    let Some(start) = c.points.iter().position(|p| p.is_on_curve()) else {
        return;
    };
    c.points.rotate_left(start);
    // The segment ending at an on-curve point is typed by that point. Reversed,
    // the segment from on_i to on_i+1 ends at on_i, so on_i takes on_i+1's type.
    let on: Vec<usize> = (0..n).filter(|&i| c.points[i].is_on_curve()).collect();
    let kinds: Vec<PointKind> = on.iter().map(|&i| c.points[i].kind).collect();
    for (k, &i) in on.iter().enumerate() {
        c.points[i].kind = kinds[(k + 1) % kinds.len()];
    }
    c.points[1..].reverse();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Point;

    #[test]
    fn places_with_scale_flip_and_rotation() {
        let mut r = ComponentRef::new(0, "leaf", Vec2::new(100.0, 50.0));
        assert_eq!(r.apply(Vec2::new(10.0, 0.0)), Vec2::new(110.0, 50.0));
        r.flip_x = true;
        r.scale = 2.0;
        assert_eq!(r.apply(Vec2::new(10.0, 5.0)), Vec2::new(80.0, 60.0));
        r.flip_x = false;
        r.scale = 1.0;
        r.rotate = 90.0;
        let p = r.apply(Vec2::new(10.0, 0.0));
        assert!((p.x - 100.0).abs() < 1e-9 && (p.y - 60.0).abs() < 1e-9);
    }

    #[test]
    fn mirrored_placement_keeps_a_valid_contour_and_reverses_it() {
        let c = Contour::new(
            0,
            None,
            vec![
                Point::line(0, 0.0, 0.0),
                Point::line(1, 100.0, 0.0),
                Point::off(2, 100.0, 50.0),
                Point::off(3, 50.0, 100.0),
                Point::curve(4, 0.0, 100.0),
            ],
        );
        let comp = Component {
            id: "leaf".into(),
            name: "Leaf".into(),
            kind: ComponentKind::Leaf,
            contours: vec![c],
        };
        let mut r = ComponentRef::new(0, "leaf", Vec2::ZERO);
        r.flip_x = true;
        let placed = &r.place(&comp)[0];
        assert_eq!(placed.validate(), Ok(()));
        let ids: Vec<u32> = placed.points.iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![0, 4, 3, 2, 1]);
        // The curve now ends at point 1 (the old start of the curve), the line
        // closing back to 0 ends at 0.
        assert_eq!(placed.points[4].kind, PointKind::Curve);
        assert_eq!(placed.points[1].kind, PointKind::Line);
        assert_eq!(placed.points[0].kind, PointKind::Line);
    }
}
