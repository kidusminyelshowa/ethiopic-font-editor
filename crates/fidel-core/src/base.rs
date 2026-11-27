//! Bases: the 1st-order drawing that roots each family.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::component::ComponentRef;
use crate::geometry::{Contour, Vec2};

pub type BaseId = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Base {
    pub id: BaseId,
    pub name: String,
    pub advance_width: f64,
    /// Contours, each optionally tagged with a part (stem, leg, bowl ...).
    #[serde(default)]
    pub contours: Vec<Contour>,
    /// Named points that pin where alterations attach on this base, when the
    /// automatic placement rule is not what the designer wants.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub anchors: BTreeMap<String, Vec2>,
    /// Leaves, caps and corners placed on this base. They are part of its
    /// outline in every fidel built from it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<ComponentRef>,
    /// For a base made from another row's base (ሸ from ሰ, ጀ from ደ): where
    /// it comes from and what is added. While it follows, its outline is
    /// rebuilt whenever the source or the added marks change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derived: Option<Derived>,
    /// Sidebearings and width set by other glyphs (`=ሀ+10`).
    #[serde(default, skip_serializing_if = "crate::metric_keys::MetricKeys::is_empty")]
    pub metric_keys: crate::metric_keys::MetricKeys,
}

/// A base built from another base plus marks such as a cap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Derived {
    pub from: BaseId,
    /// Additive alterations placed on the source base.
    #[serde(default)]
    pub adds: Vec<crate::alteration::AlterationId>,
    /// Drawn by hand: no longer rebuilt from the source.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub own: bool,
}

impl Base {
    pub fn new(id: impl Into<BaseId>, name: impl Into<String>, advance_width: f64) -> Self {
        Base {
            id: id.into(),
            name: name.into(),
            advance_width,
            contours: Vec::new(),
            anchors: BTreeMap::new(),
            components: Vec::new(),
            derived: None,
            metric_keys: Default::default(),
        }
    }

    /// Whether the outline is rebuilt from another base.
    pub fn follows(&self) -> bool {
        self.derived.as_ref().is_some_and(|d| !d.own)
    }
}
