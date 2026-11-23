//! Components: a leaf, cap or corner drawn once and placed on any base.
//! Hornus's leafs are the Ethiopic counterpart of serifs; drawing them once
//! keeps every terminal in the font the same.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::geometry::{Contour, ContourId, PointKind, Vec2};
use crate::parts::Part;

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
    /// Placed by rule on both ends of every stroke tagged with one of these
    /// parts, mirrored on the left end. A leaf is drawn for the right-hand
    /// end of a bar, with the bar's top corner at the origin.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lands_on: Vec<Part>,
    /// Ends switched off, as `base/contour:side` or
    /// `alteration/contour:side` (side `l` or `r`).
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub off: BTreeSet<String>,
}

impl Component {
    pub fn new(id: impl Into<ComponentId>, name: impl Into<String>, kind: ComponentKind) -> Self {
        Component {
            id: id.into(),
            name: name.into(),
            kind,
            contours: Vec::new(),
            lands_on: match kind {
                ComponentKind::Leaf => vec![Part::Bar, Part::Branch],
                _ => Vec::new(),
            },
            off: BTreeSet::new(),
        }
    }

    /// Where this component lands by rule on a stroke `owner/contour`: its
    /// right end, then its left end mirrored. Each comes with its key.
    pub fn ends(&self, owner: &str, contour: &Contour) -> Vec<(String, ComponentRef)> {
        if self.contours.is_empty() || !contour.part.is_some_and(|p| self.lands_on.contains(&p)) {
            return Vec::new();
        }
        let Some(b) = contour.bounds() else { return Vec::new() };
        let mut out = Vec::new();
        for (side, x, flip) in [("r", b.max.x, false), ("l", b.min.x, true)] {
            let key = format!("{owner}/{}:{side}", contour.id);
            if self.off.contains(&key) {
                continue;
            }
            let mut r = ComponentRef::new(0, self.id.clone(), Vec2::new(x, b.max.y));
            r.flip_x = flip;
            r.on = Some(contour.id);
            out.push((key, r));
        }
        out
    }
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
        let comp = Component { contours: vec![c], ..Component::new("leaf", "Leaf", ComponentKind::Leaf) };
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

    #[test]
    fn a_leaf_lands_on_both_ends_of_a_bar() {
        let leaf = Contour::rect(0, Some(Part::Leaf), Vec2::new(-20.0, -30.0), Vec2::new(0.0, 0.0));
        let mut comp =
            Component { contours: vec![leaf], ..Component::new("leaf", "Leaf", ComponentKind::Leaf) };
        let bar = Contour::rect(3, Some(Part::Bar), Vec2::new(50.0, 640.0), Vec2::new(460.0, 700.0));
        let ends = comp.ends("ta", &bar);
        assert_eq!(ends.len(), 2);
        assert_eq!(ends[0].0, "ta/3:r");
        assert_eq!(ends[0].1.at, Vec2::new(460.0, 700.0));
        let left = ends[1].1.place(&comp)[0].bounds().unwrap();
        assert_eq!((left.min.x, left.max.x), (50.0, 70.0));
        // Not on legs, and an end can be switched off.
        let leg = Contour::rect(1, Some(Part::Leg), Vec2::new(0.0, 0.0), Vec2::new(60.0, 700.0));
        assert!(comp.ends("ta", &leg).is_empty());
        comp.off.insert("ta/3:l".into());
        assert_eq!(comp.ends("ta", &bar).len(), 1);
    }
}
