//! Organizing glyphs: colour marks, tags and notes on glyphs and families,
//! and saved filters for the grid. None of it reaches the exported font.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkColor {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Gray,
}

/// What the designer noted on one glyph or family.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GlyphMark {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<MarkColor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

impl GlyphMark {
    pub fn is_empty(&self) -> bool {
        self.color.is_none() && self.tags.is_empty() && self.note.trim().is_empty()
    }

    /// Trimmed, without empty or repeated tags.
    fn tidy(mut self) -> Self {
        let mut seen = std::collections::BTreeSet::new();
        self.tags = self
            .tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty() && seen.insert(t.to_lowercase()))
            .collect();
        if self.note.trim().is_empty() {
            self.note.clear();
        }
        self
    }
}

/// A filter saved under a name: a search plus criteria such as `state:adjusted`,
/// `color:red`, `tag:review` or `has:note`, read by the grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SmartFilter {
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub query: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Organize {
    /// By key: `fidel:ha/kaib`, `symbol:uni1361` or `family:ha`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub marks: BTreeMap<String, GlyphMark>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<SmartFilter>,
}

impl Organize {
    pub fn is_empty(&self) -> bool {
        self.marks.is_empty() && self.filters.is_empty()
    }

    /// Set what is noted on one key; an empty mark removes it.
    pub fn set_mark(&mut self, key: &str, mark: GlyphMark) {
        let mark = mark.tidy();
        if mark.is_empty() {
            self.marks.remove(key);
        } else {
            self.marks.insert(key.to_string(), mark);
        }
    }

    /// Every tag in use, sorted, each once.
    pub fn tags(&self) -> Vec<String> {
        let mut by_lower = BTreeMap::new();
        for t in self.marks.values().flat_map(|m| &m.tags) {
            by_lower.entry(t.to_lowercase()).or_insert_with(|| t.clone());
        }
        by_lower.into_values().collect()
    }

    /// Replace the saved filters, dropping unnamed ones and repeated names.
    pub fn set_filters(&mut self, filters: Vec<SmartFilter>) {
        let mut seen = std::collections::BTreeSet::new();
        self.filters = filters
            .into_iter()
            .map(|mut f| {
                f.name = f.name.trim().to_string();
                f
            })
            .filter(|f| !f.name.is_empty() && seen.insert(f.name.to_lowercase()))
            .collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_tidied_and_empty_ones_removed() {
        let mut o = Organize::default();
        o.set_mark(
            "fidel:ha/kaib",
            GlyphMark {
                color: Some(MarkColor::Red),
                tags: vec![" review ".into(), "Review".into(), "".into()],
                note: " ".into(),
            },
        );
        assert_eq!(o.marks["fidel:ha/kaib"].tags, vec!["review".to_string()]);
        assert_eq!(o.marks["fidel:ha/kaib"].note, "");
        o.set_mark("family:ha", GlyphMark { note: "Wide counter".into(), ..Default::default() });
        o.set_mark("fidel:la/giiz", GlyphMark { tags: vec!["Spacing".into()], ..Default::default() });
        assert_eq!(o.tags(), vec!["review".to_string(), "Spacing".to_string()]);
        o.set_mark("fidel:ha/kaib", GlyphMark::default());
        assert!(!o.marks.contains_key("fidel:ha/kaib"));
    }

    #[test]
    fn filters_need_a_name_of_their_own() {
        let mut o = Organize::default();
        let f = |name: &str| SmartFilter {
            name: name.into(),
            query: String::new(),
            rules: vec!["state:adjusted".into()],
        };
        o.set_filters(vec![f("Adjusted"), f(" "), f("adjusted ")]);
        assert_eq!(o.filters.len(), 1);
        assert_eq!(o.filters[0].name, "Adjusted");
    }
}
