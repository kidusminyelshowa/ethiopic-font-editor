//! Alterations: the named, reusable transformations that turn a base into an
//! order (Hornus fig. 4). "To similar alteration, similar positioning."

use serde::{Deserialize, Serialize};

use crate::base::Base;
use crate::geometry::{Contour, Rect, Vec2};
use crate::parts::Part;

/// Stable, human-readable id such as `loop.bottom-right`.
pub type AlterationId = String;

/// The alteration verbs from Hornus fig. 4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verb {
    /// Adds a short stroke (2nd and 3rd orders).
    Stroke,
    /// Adds a ring (5th and 7th orders).
    Loop,
    /// Extends a leg.
    Lengthen,
    /// Shortens a leg (4th and 7th orders).
    Shorten,
    /// Bends a stem.
    Bend,
    /// Pulls a stem end sideways (4th order: ቃ ታ ና).
    Stretch,
    /// Kinks the first stroke (6th order).
    Crick,
    /// Adds a cap (capped Amharic bases).
    Cap,
    /// Adds a foot (labialised 4th order).
    Shoe,
}

impl Verb {
    /// Additive verbs bring their own drawn parts that are placed on the base.
    /// The others deform the base's own contours.
    pub fn is_additive(self) -> bool {
        matches!(self, Verb::Stroke | Verb::Loop | Verb::Cap | Verb::Shoe)
    }
}

/// Where on the base an alteration attaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Region {
    TopLeft,
    TopRight,
    MiddleLeft,
    MiddleRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    /// If the base defines an anchor with this name, it wins over the
    /// automatic rule. This is how a designer pins a placement per base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    pub region: Region,
    /// Parts to attach to, in order of preference. The first part that the
    /// base has tagged is used. Empty means "the whole base".
    #[serde(default)]
    pub parts: Vec<Part>,
    /// Constant offset applied after placement.
    #[serde(default)]
    pub offset: Vec2,
}

/// A reusable alteration. For additive verbs, `contours` are drawn once with
/// their attachment point at the origin (0, 0); the resolver moves them onto
/// each base.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Alteration {
    pub id: AlterationId,
    pub name: String,
    pub verb: Verb,
    pub placement: Placement,
    #[serde(default)]
    pub contours: Vec<Contour>,
    /// Set on a copy made for part of the system (one fidel, one family or
    /// one order), so it can be joined back to the shared alteration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<AlterationId>,
    /// The Pa-height zone this alteration lands on (see
    /// [`crate::project::Metrics::zones`]). A shortened leg ends on it, a
    /// crick or stretch starts at it, an additive mark sits at its height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    /// How far a deform pulls, in font units: the sideways throw of a crick
    /// or stretch, how much a lengthen adds. `None` uses a default that
    /// follows the stroke width and Pa-height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
}

/// Points this close (in font units) count as being on the same edge.
pub const EDGE_TOLERANCE: f64 = 10.0;

/// Where an alteration lands on a base, and whether the automatic rule had to
/// fall back because the base lacks the preferred part tags.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachPoint {
    pub at: Vec2,
    pub fallback: Option<String>,
}

impl Placement {
    /// Find the attachment point on `base`. Returns `None` only when the base
    /// has no contours at all.
    pub fn attach_point(&self, base: &Base) -> Option<AttachPoint> {
        if let Some(name) = &self.anchor {
            if let Some(at) = base.anchors.get(name) {
                return Some(AttachPoint { at: *at + self.offset, fallback: None });
            }
        }

        let mut fallback = None;
        let mut candidates: Vec<&Contour> = Vec::new();
        for part in &self.parts {
            candidates = base.contours.iter().filter(|c| c.part == Some(*part)).collect();
            if !candidates.is_empty() {
                break;
            }
        }
        if candidates.is_empty() {
            if !self.parts.is_empty() {
                let names: Vec<String> = self.parts.iter().map(|p| format!("{p:?}").to_lowercase()).collect();
                fallback = Some(format!("no {} tagged on the base; used the whole base", names.join("/")));
            }
            candidates = base.contours.iter().collect();
        }

        let at = attach_on(&candidates, self.region)?;
        Some(AttachPoint { at: at + self.offset, fallback })
    }
}

/// Pick the contour that best matches the region and return the attachment
/// point on it.
///
/// Bottom regions pick the contour(s) reaching lowest, then the rightmost (or
/// leftmost) of those, and attach at the middle of its bottom end. This is
/// "the leg that ends lowest on the right" for the 5th-order loop.
fn attach_on(candidates: &[&Contour], region: Region) -> Option<Vec2> {
    let boxed: Vec<(&Contour, Rect)> =
        candidates.iter().filter_map(|c| c.bounds().map(|b| (*c, b))).collect();
    if boxed.is_empty() {
        return None;
    }
    let right = matches!(region, Region::TopRight | Region::MiddleRight | Region::BottomRight);
    let pick_side = |a: &Rect, b: &Rect| {
        if right {
            a.max.x.total_cmp(&b.max.x)
        } else {
            b.min.x.total_cmp(&a.min.x)
        }
    };

    match region {
        Region::BottomLeft | Region::BottomRight => {
            let lowest = boxed.iter().map(|(_, b)| b.min.y).fold(f64::INFINITY, f64::min);
            let (c, b) = boxed
                .iter()
                .filter(|(_, b)| b.min.y <= lowest + EDGE_TOLERANCE)
                .max_by(|(_, a), (_, b)| pick_side(a, b))?;
            Some(Vec2::new(edge_mid_x(c, |y| y <= b.min.y + EDGE_TOLERANCE), b.min.y))
        }
        Region::TopLeft | Region::TopRight => {
            let highest = boxed.iter().map(|(_, b)| b.max.y).fold(f64::NEG_INFINITY, f64::max);
            let (c, b) = boxed
                .iter()
                .filter(|(_, b)| b.max.y >= highest - EDGE_TOLERANCE)
                .max_by(|(_, a), (_, b)| pick_side(a, b))?;
            Some(Vec2::new(edge_mid_x(c, |y| y >= b.max.y - EDGE_TOLERANCE), b.max.y))
        }
        Region::MiddleLeft | Region::MiddleRight => {
            let (_, b) = boxed.iter().max_by(|(_, a), (_, b)| pick_side(a, b))?;
            let x = if right { b.max.x } else { b.min.x };
            Some(Vec2::new(x, (b.min.y + b.max.y) / 2.0))
        }
    }
}

/// Middle x of the on-curve points of `c` whose y passes `on_edge`.
fn edge_mid_x(c: &Contour, on_edge: impl Fn(f64) -> bool) -> f64 {
    let xs: Vec<f64> =
        c.points.iter().filter(|p| p.is_on_curve() && on_edge(p.pos.y)).map(|p| p.pos.x).collect();
    if xs.is_empty() {
        return c.bounds().map(|b| b.center().x).unwrap_or(0.0);
    }
    let lo = xs.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (lo + hi) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Contour;

    fn base_with(contours: Vec<Contour>) -> Base {
        Base { contours, ..Base::new("t", "t", 600.0) }
    }

    fn placement(region: Region, parts: Vec<Part>) -> Placement {
        Placement { anchor: None, region, parts, offset: Vec2::ZERO }
    }

    #[test]
    fn bottom_right_picks_lowest_rightmost_leg() {
        // Two legs reaching the bottom, one short leg on the far right that
        // stops higher up, and a bar. The loop goes on the right leg that
        // reaches the bottom, not the short one.
        let base = base_with(vec![
            Contour::rect(0, Some(Part::Leg), Vec2::new(50.0, 0.0), Vec2::new(110.0, 700.0)),
            Contour::rect(1, Some(Part::Leg), Vec2::new(400.0, 0.0), Vec2::new(460.0, 700.0)),
            Contour::rect(2, Some(Part::Leg), Vec2::new(500.0, 300.0), Vec2::new(540.0, 700.0)),
            Contour::rect(3, Some(Part::Bar), Vec2::new(50.0, 640.0), Vec2::new(560.0, 700.0)),
        ]);
        let at = placement(Region::BottomRight, vec![Part::Leg]).attach_point(&base).unwrap();
        assert_eq!(at.at, Vec2::new(430.0, 0.0));
        assert!(at.fallback.is_none());
    }

    #[test]
    fn untagged_base_falls_back_and_says_so() {
        let base = base_with(vec![Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(100.0, 100.0))]);
        let at = placement(Region::BottomRight, vec![Part::Leg]).attach_point(&base).unwrap();
        assert_eq!(at.at, Vec2::new(50.0, 0.0));
        assert!(at.fallback.unwrap().contains("leg"));
    }

    #[test]
    fn anchor_wins_over_rule() {
        let mut base = base_with(vec![Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(100.0, 100.0))]);
        base.anchors.insert("loop5".into(), Vec2::new(77.0, -5.0));
        let mut p = placement(Region::BottomRight, vec![]);
        p.anchor = Some("loop5".into());
        p.offset = Vec2::new(1.0, 1.0);
        assert_eq!(p.attach_point(&base).unwrap().at, Vec2::new(78.0, -4.0));
    }

    #[test]
    fn middle_and_top_regions() {
        let base = base_with(vec![Contour::rect(
            0,
            Some(Part::Stem),
            Vec2::new(100.0, 0.0),
            Vec2::new(160.0, 700.0),
        )]);
        let mid = placement(Region::MiddleRight, vec![Part::Stem]).attach_point(&base).unwrap();
        assert_eq!(mid.at, Vec2::new(160.0, 350.0));
        let top = placement(Region::TopLeft, vec![Part::Stem]).attach_point(&base).unwrap();
        assert_eq!(top.at, Vec2::new(130.0, 700.0));
    }

    #[test]
    fn empty_base_has_no_attach_point() {
        assert!(placement(Region::BottomRight, vec![]).attach_point(&base_with(vec![])).is_none());
    }
}
