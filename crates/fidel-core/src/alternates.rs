//! Alternates: other drawings of a character that a feature swaps in, such
//! as ሀ.ss01 for a stylistic set or ሀ.locl.TIR for Tigrinya. They have no
//! code point of their own; their suffix says which feature uses them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::features::glyph_name;
use crate::geometry::{Contour, Vec2};
use crate::order::Order;
use crate::project::{DrawingTarget, ModelError, Project};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Alternate {
    pub id: String,
    /// The character it stands in for.
    pub of: char,
    /// `ss01`, `salt`, `cv02`, or `locl.TIR` for a language.
    pub suffix: String,
    pub advance_width: f64,
    #[serde(default)]
    pub contours: Vec<Contour>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub anchors: BTreeMap<String, Vec2>,
}

impl Alternate {
    /// `uni1200.ss01`, the name in the font.
    pub fn glyph_name(&self) -> String {
        format!("{}.{}", glyph_name(self.of), self.suffix)
    }

    /// `ሀ.ss01`, the name in the app.
    pub fn label(&self) -> String {
        format!("{}.{}", self.of, self.suffix)
    }
}

/// A suffix a feature can use: a tag, then for `locl` a language.
pub fn valid_suffix(s: &str) -> bool {
    let mut parts = s.split('.');
    let tag = parts.next().unwrap_or("");
    let ok_tag = tag.len() == 4 && tag.chars().all(|c| c.is_ascii_alphanumeric());
    match (tag, parts.next(), parts.next()) {
        ("locl", Some(lang), None) => {
            !lang.is_empty() && lang.len() <= 4 && lang.chars().all(|c| c.is_ascii_alphanumeric())
        }
        (_, None, _) => ok_tag,
        _ => false,
    }
}

impl Project {
    /// The character a base, symbol or fidel drawing is for.
    pub fn char_of(&self, target: &DrawingTarget) -> Option<char> {
        match target {
            DrawingTarget::Symbol(id) => self.symbols.get(id).map(|s| s.codepoint),
            DrawingTarget::Base(id) => self
                .families
                .values()
                .find(|f| &f.base == id)
                .and_then(|f| f.fidels.get(&Order::Giiz))
                .and_then(|fi| fi.codepoint),
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id).ok()?;
                self.fidel(&family, order).ok()?.codepoint
            }
            DrawingTarget::Alternate(id) => self.alternates.get(id).map(|a| a.of),
            _ => None,
        }
    }

    pub fn alternates_of(&self, c: char) -> Vec<&Alternate> {
        self.alternates.values().filter(|a| a.of == c).collect()
    }

    /// Add an alternate of `c`, starting as a copy of its glyph.
    pub fn add_alternate(&mut self, c: char, suffix: &str) -> Result<String, ModelError> {
        let suffix = suffix.trim().to_string();
        if !valid_suffix(&suffix) {
            return Err(ModelError::BadSuffix(suffix));
        }
        if self.alternates.values().any(|a| a.of == c && a.suffix == suffix) {
            return Err(ModelError::AlternateTaken(format!("{c}.{suffix}")));
        }
        let shape = self.glyph_shape(c).ok_or(ModelError::NoGlyph(c))?;
        let mut n = self.alternates.len() + 1;
        while self.alternates.contains_key(&format!("alt{n}")) {
            n += 1;
        }
        let id = format!("alt{n}");
        self.alternates.insert(
            id.clone(),
            Alternate {
                id: id.clone(),
                of: c,
                suffix,
                advance_width: shape.advance,
                contours: shape.contours,
                anchors: shape.anchors,
            },
        );
        Ok(id)
    }

    pub fn remove_alternate(&mut self, id: &str) -> Result<(), ModelError> {
        self.alternates.remove(id).map(|_| ()).ok_or_else(|| ModelError::UnknownAlternate(id.into()))
    }

    /// The features that swap alternates in: one per tag, `locl` per language.
    pub(crate) fn alternate_features(
        &self,
        has: &dyn Fn(char) -> bool,
        langs: &[(String, String)],
    ) -> String {
        let mut by_tag: BTreeMap<String, Vec<(Option<String>, String, String)>> = BTreeMap::new();
        for a in self.alternates.values() {
            if !has(a.of) || a.contours.iter().all(|c| c.open) {
                continue;
            }
            let (tag, lang) = match a.suffix.split_once('.') {
                Some((t, l)) => (t.to_string(), Some(l.to_string())),
                None => (a.suffix.clone(), None),
            };
            by_tag.entry(tag).or_default().push((lang, glyph_name(a.of), a.glyph_name()));
        }
        let mut t = String::new();
        for (tag, subs) in by_tag {
            t.push_str(&format!("feature {tag} {{\n"));
            for (_, from, to) in subs.iter().filter(|s| s.0.is_none()) {
                t.push_str(&format!("  sub {from} by {to};\n"));
            }
            let mut by_lang: BTreeMap<&str, Vec<(&String, &String)>> = BTreeMap::new();
            for (lang, from, to) in &subs {
                if let Some(l) = lang {
                    by_lang.entry(l).or_default().push((from, to));
                }
            }
            for (lang, pairs) in by_lang {
                for (script, _) in langs.iter().filter(|(_, l)| l.trim() == lang) {
                    t.push_str(&format!("  script {script};\n  language {lang};\n"));
                    for (from, to) in &pairs {
                        t.push_str(&format!("  sub {from} by {to};\n"));
                    }
                }
            }
            t.push_str(&format!("}} {tag};\n"));
        }
        t
    }

    /// Characters that two glyphs claim, with what claims them.
    pub fn duplicate_codepoints(&self) -> Vec<(char, Vec<String>)> {
        let mut seen: BTreeMap<char, Vec<String>> = BTreeMap::new();
        for s in self.symbols.values() {
            seen.entry(s.codepoint).or_default().push(format!("symbol {}", s.name));
        }
        for f in self.families.values() {
            for (o, fi) in &f.fidels {
                if let Some(c) = fi.codepoint {
                    seen.entry(c).or_default().push(format!("{} {}", f.name, o.name()));
                }
            }
        }
        seen.into_iter().filter(|(_, v)| v.len() > 1).collect()
    }

    /// Give a symbol another character, refusing one already taken.
    pub fn set_symbol_codepoint(&mut self, id: &str, c: char) -> Result<(), ModelError> {
        let taken = self.symbols.values().any(|s| s.id != id && s.codepoint == c)
            || self.families.values().any(|f| f.fidels.values().any(|fi| fi.codepoint == Some(c)));
        if taken {
            return Err(ModelError::CodepointTaken(c));
        }
        let s = self.symbols.get_mut(id).ok_or_else(|| ModelError::UnknownSymbol(id.into()))?;
        let old = std::mem::replace(&mut s.codepoint, c);
        for a in self.alternates.values_mut().filter(|a| a.of == old) {
            a.of = c;
        }
        Ok(())
    }
}
