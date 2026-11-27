//! Guides: lines the designer draws to measure and align against. Global
//! guides show in every drawing; local ones belong to one drawing.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A straight guide through a point, at an angle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Guide {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    /// Degrees counter-clockwise from horizontal: 0 is a horizontal guide, 90 a vertical one.
    #[serde(default)]
    pub angle: f64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    /// A CSS colour, or none for the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Every guide in a project.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Guides {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub global: Vec<Guide>,
    /// Keyed by drawing (`base:la`, `fidel:ha:2`, ...).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub local: BTreeMap<String, Vec<Guide>>,
}

impl Guides {
    pub fn is_empty(&self) -> bool {
        self.global.is_empty() && self.local.values().all(Vec::is_empty)
    }

    pub fn local(&self, drawing: &str) -> Vec<Guide> {
        self.local.get(drawing).cloned().unwrap_or_default()
    }

    /// Replace a drawing's local guides and the global ones.
    pub fn set(&mut self, drawing: &str, local: Vec<Guide>, global: Vec<Guide>) {
        if local.is_empty() {
            self.local.remove(drawing);
        } else {
            self.local.insert(drawing.to_string(), local);
        }
        self.global = global;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guide(id: u32, angle: f64) -> Guide {
        Guide { id, x: 10.0, y: 20.0, angle, name: String::new(), locked: false, color: None }
    }

    #[test]
    fn setting_guides_keeps_other_drawings() {
        let mut g = Guides::default();
        g.set("base:la", vec![guide(1, 0.0)], vec![guide(2, 90.0)]);
        g.set("base:ha", vec![guide(3, 45.0)], vec![guide(2, 90.0)]);
        assert_eq!(g.local("base:la").len(), 1);
        assert_eq!(g.local("base:ha")[0].angle, 45.0);
        g.set("base:la", vec![], vec![]);
        assert!(g.local("base:la").is_empty());
        assert!(!g.local.contains_key("base:la"));
        assert!(!g.is_empty());
    }

    #[test]
    fn a_plain_guide_writes_only_what_it_needs() {
        let json = serde_json::to_string(&guide(1, 0.0)).unwrap();
        assert_eq!(json, r#"{"id":1,"x":10.0,"y":20.0,"angle":0.0}"#);
    }
}
