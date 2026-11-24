//! Components: a leaf, cap or corner drawn once and placed on any base.
//! Hornus's leafs are the Ethiopic counterpart of serifs; drawing them once
//! keeps every terminal in the font the same.

use std::collections::{BTreeMap, BTreeSet};

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

/// Which corners a corner component lands on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CornerSide {
    /// Corners that point out of the ink.
    #[default]
    Outer,
    /// Corners that point into the ink (where two strokes meet).
    Inner,
    Both,
}

impl CornerSide {
    fn is_default(&self) -> bool {
        *self == CornerSide::Outer
    }
}

/// A part's settings, by axis name.
pub type PartValues = BTreeMap<String, f64>;

/// One way a part can vary inside a master, such as a leaf's size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartAxis {
    pub name: String,
    pub min: f64,
    pub default: f64,
    pub max: f64,
    /// The tag of a font axis this one follows: the part sits as far along
    /// its own range as the font sits along that axis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follows: Option<String>,
}

impl PartAxis {
    /// -1 at min, 0 at the default, 1 at max.
    pub fn normalize(&self, v: f64) -> f64 {
        let v = v.clamp(self.min.min(self.max), self.max.max(self.min));
        if v > self.default && self.max > self.default {
            (v - self.default) / (self.max - self.default)
        } else if v < self.default && self.default > self.min {
            (v - self.default) / (self.default - self.min)
        } else {
            0.0
        }
    }

    /// The value at a normalized position.
    pub fn denormalize(&self, n: f64) -> f64 {
        let n = n.clamp(-1.0, 1.0);
        if n >= 0.0 {
            self.default + n * (self.max - self.default)
        } else {
            self.default + n * (self.default - self.min)
        }
    }
}

/// The part drawn at another setting of its axes. Its contours must match
/// the main drawing point for point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartState {
    /// Axis values; axes left out sit at their default.
    #[serde(default)]
    pub location: PartValues,
    #[serde(default)]
    pub contours: Vec<Contour>,
}

/// An adjustment to one rule placement: nudged, scaled or flipped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tweak {
    #[serde(default)]
    pub dx: f64,
    #[serde(default)]
    pub dy: f64,
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default)]
    pub flip: bool,
    /// Settings of the part's own axes here.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: PartValues,
}

impl Default for Tweak {
    fn default() -> Self {
        Tweak { dx: 0.0, dy: 0.0, scale: 1.0, flip: false, values: PartValues::new() }
    }
}

impl Tweak {
    pub fn is_identity(&self) -> bool {
        *self == Tweak::default()
    }
}

/// One place a component lands by rule.
#[derive(Debug, Clone, PartialEq)]
pub struct End {
    /// `owner/contour:side`, the key `off` and `tweaks` use.
    pub key: String,
    /// "Right end", "Bottom", "Outer corner".
    pub label: String,
    /// The placement, with its tweak applied.
    pub placement: ComponentRef,
    /// False when switched off.
    pub on: bool,
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
    /// For a corner component: which corners it lands on.
    #[serde(default, skip_serializing_if = "CornerSide::is_default")]
    pub corners: CornerSide,
    /// Per-placement adjustments, by the same keys as `off`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tweaks: BTreeMap<String, Tweak>,
    /// Ways the part varies inside one master. The main drawing is the
    /// part with every axis at its default.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub axes: Vec<PartAxis>,
    /// The part drawn at other settings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<PartState>,
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
            corners: CornerSide::Outer,
            tweaks: BTreeMap::new(),
            axes: Vec::new(),
            states: Vec::new(),
        }
    }

    /// The setting of every axis: an axis that follows a font axis takes
    /// the font's position (`font` holds normalized positions by tag), the
    /// others the given value or their default.
    pub fn values_at(&self, given: &PartValues, font: &[(String, f64)]) -> PartValues {
        self.axes
            .iter()
            .map(|a| {
                let tied = a
                    .follows
                    .as_ref()
                    .and_then(|t| font.iter().find(|(f, _)| f == t))
                    .map(|(_, n)| a.denormalize(*n));
                (a.name.clone(), tied.or_else(|| given.get(&a.name).copied()).unwrap_or(a.default))
            })
            .collect()
    }

    /// Why a state cannot interpolate with the main drawing.
    pub fn state_problem(&self, index: usize) -> Option<String> {
        let s = self.states.get(index)?;
        crate::compat::difference(&self.contours, &s.contours)
    }

    /// The part at these settings, interpolated between its states. States
    /// that do not match the main drawing are left out.
    pub fn shape(&self, values: &PartValues) -> Vec<Contour> {
        if self.axes.is_empty() || self.states.is_empty() {
            return self.contours.clone();
        }
        let loc = |l: &PartValues| -> Vec<f64> {
            self.axes.iter().map(|a| a.normalize(l.get(&a.name).copied().unwrap_or(a.default))).collect()
        };
        let mut locs = vec![vec![0.0; self.axes.len()]];
        let mut vals = vec![flat(&self.contours)];
        for (i, s) in self.states.iter().enumerate() {
            let l = loc(&s.location);
            let taken = locs.iter().any(|m| m.iter().zip(&l).all(|(a, b)| (a - b).abs() < 1e-9));
            if taken || self.state_problem(i).is_some() {
                continue;
            }
            locs.push(l);
            vals.push(flat(&s.contours));
        }
        if locs.len() == 1 {
            return self.contours.clone();
        }
        let Ok(model) = crate::designspace::Model::new(&locs) else {
            return self.contours.clone();
        };
        let out = model.interpolate(&vals, &loc(values));
        let mut contours = self.contours.clone();
        let mut it = out.chunks(2);
        for c in &mut contours {
            for p in &mut c.points {
                if let Some(&[x, y]) = it.next() {
                    p.pos = Vec2::new(x, y);
                }
            }
        }
        contours
    }

    /// Where this component lands by rule on a stroke `owner/contour`, the
    /// ends switched off included.
    ///
    /// - A leaf lands on the right end of the stroke with its top corner at
    ///   the origin, and on the left end mirrored.
    /// - A cap lands on the bottom of the stroke, its origin at the middle.
    /// - A corner lands on each sharp corner, drawn for a corner whose edges
    ///   run right and up from the origin and turned to fit.
    pub fn all_ends(&self, owner: &str, contour: &Contour) -> Vec<End> {
        if self.contours.is_empty() || !contour.part.is_some_and(|p| self.lands_on.contains(&p)) {
            return Vec::new();
        }
        let Some(b) = contour.bounds() else { return Vec::new() };
        let mut raw: Vec<(String, String, ComponentRef)> = Vec::new();
        let at = |x: f64, y: f64| {
            let mut r = ComponentRef::new(0, self.id.clone(), Vec2::new(x, y));
            r.on = Some(contour.id);
            r
        };
        match self.kind {
            ComponentKind::Leaf => {
                for (side, label, x, flip) in
                    [("r", "Right end", b.max.x, false), ("l", "Left end", b.min.x, true)]
                {
                    let mut r = at(x, b.max.y);
                    r.flip_x = flip;
                    raw.push((side.into(), label.into(), r));
                }
            }
            ComponentKind::Cap => {
                let xs: Vec<f64> = contour
                    .points
                    .iter()
                    .filter(|p| p.is_on_curve() && (p.pos.y - b.min.y).abs() < 1.0)
                    .map(|p| p.pos.x)
                    .collect();
                let x = match (xs.iter().copied().reduce(f64::min), xs.iter().copied().reduce(f64::max)) {
                    (Some(lo), Some(hi)) => (lo + hi) / 2.0,
                    _ => (b.min.x + b.max.x) / 2.0,
                };
                raw.push(("b".into(), "Bottom".into(), at(x, b.min.y)));
            }
            ComponentKind::Corner => {
                for c in corners(contour) {
                    let wanted = match self.corners {
                        CornerSide::Outer => c.outer,
                        CornerSide::Inner => !c.outer,
                        CornerSide::Both => true,
                    };
                    if !wanted {
                        continue;
                    }
                    let mut r = at(c.at.x, c.at.y);
                    r.rotate = (c.along.y.atan2(c.along.x).to_degrees() * 1000.0).round() / 1000.0;
                    let (cx, cy) = ((b.min.x + b.max.x) / 2.0, (b.min.y + b.max.y) / 2.0);
                    let v = if c.at.y >= cy { "top" } else { "bottom" };
                    let h = if c.at.x >= cx { "right" } else { "left" };
                    let label = format!("{} corner, {v} {h}", if c.outer { "Outer" } else { "Inner" });
                    raw.push((format!("p{}", c.point), label, r));
                }
            }
        }
        raw.into_iter()
            .map(|(side, label, mut r)| {
                let key = format!("{owner}/{}:{side}", contour.id);
                if let Some(t) = self.tweaks.get(&key) {
                    r.at += Vec2::new(t.dx, t.dy);
                    r.scale *= t.scale;
                    if t.flip {
                        r.flip_x = !r.flip_x;
                    }
                    r.values = t.values.clone();
                }
                End { on: !self.off.contains(&key), key, label, placement: r }
            })
            .collect()
    }

    /// Where this component lands by rule on a stroke, each with its key.
    pub fn ends(&self, owner: &str, contour: &Contour) -> Vec<(String, ComponentRef)> {
        self.all_ends(owner, contour).into_iter().filter(|e| e.on).map(|e| (e.key, e.placement)).collect()
    }
}

/// A sharp corner of a contour.
struct Corner {
    point: crate::geometry::PointId,
    at: Vec2,
    /// The edge the component's x axis runs along.
    along: Vec2,
    outer: bool,
}

/// The sharp corners of a contour. A tagged stroke is ink on the inside, so
/// a corner is outer when it turns the way the contour winds, whichever way
/// that is.
fn corners(c: &Contour) -> Vec<Corner> {
    let pts = &c.points;
    let n = pts.len();
    let mut out = Vec::new();
    if n < 3 {
        return out;
    }
    let area: f64 = (0..n)
        .map(|i| {
            let (a, b) = (pts[i].pos, pts[(i + 1) % n].pos);
            a.x * b.y - b.x * a.y
        })
        .sum();
    let winds = if area < 0.0 { -1.0 } else { 1.0 };
    let unit = |v: Vec2| {
        let l = (v.x * v.x + v.y * v.y).sqrt();
        (l > 1e-6).then(|| Vec2::new(v.x / l, v.y / l))
    };
    // The direction from point i to the first neighbour that is somewhere else.
    let towards = |i: usize, step: isize| {
        (1..n).find_map(|k| {
            let j = (i as isize + step * k as isize).rem_euclid(n as isize) as usize;
            unit(pts[j].pos - pts[i].pos)
        })
    };
    for (i, p) in pts.iter().enumerate() {
        if !p.is_on_curve() || p.smooth {
            continue;
        }
        let (Some(back), Some(fwd)) = (towards(i, -1), towards(i, 1)) else { continue };
        // Incoming direction is -back.
        let cross = -back.x * fwd.y + back.y * fwd.x;
        let dot = -back.x * fwd.x - back.y * fwd.y;
        let turn = cross.atan2(dot).to_degrees();
        if turn.abs() < 30.0 {
            continue;
        }
        let outer = cross * winds > 0.0;
        // The edge that keeps the component's axes right-handed.
        let along = if cross > 0.0 { fwd } else { back };
        out.push(Corner { point: p.id, at: p.pos, along, outer });
    }
    out
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
    /// Settings of the part's own axes here.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: PartValues,
}

fn flat(cs: &[Contour]) -> Vec<f64> {
    cs.iter().flat_map(|c| c.points.iter().flat_map(|p| [p.pos.x, p.pos.y])).collect()
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
            values: PartValues::new(),
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
        self.place_in(component, &[])
    }

    /// Placed, with part axes that follow font axes set from `font`
    /// (normalized positions by tag).
    pub fn place_in(&self, component: &Component, font: &[(String, f64)]) -> Vec<Contour> {
        let mirrored = self.flip_x != self.flip_y;
        component
            .shape(&component.values_at(&self.values, font))
            .into_iter()
            .map(|mut c| {
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
        // A tweak nudges and scales one end.
        comp.tweaks.insert("ta/3:r".into(), Tweak { dx: 5.0, dy: -2.0, scale: 2.0, ..Tweak::default() });
        let r = &comp.ends("ta", &bar)[0].1;
        assert_eq!((r.at, r.scale), (Vec2::new(465.0, 698.0), 2.0));
    }

    #[test]
    fn a_cap_lands_on_the_bottom_of_a_leg() {
        let cap = Contour::rect(0, None, Vec2::new(-40.0, -10.0), Vec2::new(40.0, 0.0));
        let mut comp =
            Component { contours: vec![cap], ..Component::new("foot", "Foot", ComponentKind::Cap) };
        let leg = Contour::rect(1, Some(Part::Leg), Vec2::new(100.0, 0.0), Vec2::new(160.0, 700.0));
        assert!(comp.ends("la", &leg).is_empty(), "a new cap lands nowhere until told");
        comp.lands_on = vec![Part::Leg];
        let ends = comp.all_ends("la", &leg);
        assert_eq!(ends.len(), 1);
        assert_eq!((ends[0].key.as_str(), ends[0].placement.at), ("la/1:b", Vec2::new(130.0, 0.0)));
    }

    #[test]
    fn a_corner_turns_to_fit_each_corner() {
        // A spur drawn on a corner whose edges run right and up.
        let spur = Contour::rect(0, None, Vec2::new(-10.0, -10.0), Vec2::new(0.0, 0.0));
        let mut comp =
            Component { contours: vec![spur], ..Component::new("spur", "Spur", ComponentKind::Corner) };
        comp.lands_on = vec![Part::Stem];
        let stem = Contour::rect(2, Some(Part::Stem), Vec2::new(0.0, 0.0), Vec2::new(100.0, 500.0));
        let ends = comp.all_ends("ha", &stem);
        assert_eq!(ends.len(), 4);
        assert!(ends.iter().all(|e| e.label.starts_with("Outer corner")));
        assert_eq!(ends[0].label, "Outer corner, bottom left");
        // Each spur sits outside its corner.
        for e in &ends {
            let b = e.placement.place(&comp)[0].bounds().unwrap();
            let inside = b.min.x >= 0.0 && b.max.x <= 100.0 && b.min.y >= 0.0 && b.max.y <= 500.0;
            assert!(!inside, "{} at {:?}", e.key, b);
            assert_eq!(e.placement.place(&comp)[0].validate(), Ok(()));
        }
        // An L has one inner corner.
        let l = Contour::new(
            3,
            Some(Part::Stem),
            vec![
                crate::geometry::Point::line(0, 0.0, 0.0),
                crate::geometry::Point::line(1, 300.0, 0.0),
                crate::geometry::Point::line(2, 300.0, 100.0),
                crate::geometry::Point::line(3, 100.0, 100.0),
                crate::geometry::Point::line(4, 100.0, 500.0),
                crate::geometry::Point::line(5, 0.0, 500.0),
            ],
        );
        comp.corners = CornerSide::Inner;
        let inner = comp.all_ends("ha", &l);
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0].key, "ha/3:p3");
        // Edges right and up: no turn needed.
        assert_eq!(inner[0].placement.rotate, 0.0);
        comp.corners = CornerSide::Both;
        assert_eq!(comp.all_ends("ha", &l).len(), 6);
        // Drawn the other way round, the same corners are found.
        let mut back = l.clone();
        reverse(&mut back);
        comp.corners = CornerSide::Inner;
        let inner = comp.all_ends("ha", &back);
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0].placement.at, Vec2::new(100.0, 100.0));
    }
}
