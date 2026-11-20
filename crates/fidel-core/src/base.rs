//! Bases: the 1st-order drawing that roots each family.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

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
}

impl Base {
    pub fn new(id: impl Into<BaseId>, name: impl Into<String>, advance_width: f64) -> Self {
        Base {
            id: id.into(),
            name: name.into(),
            advance_width,
            contours: Vec::new(),
            anchors: BTreeMap::new(),
        }
    }
}
