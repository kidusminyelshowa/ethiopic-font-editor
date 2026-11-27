//! Kerning: pairs, classes and exceptions.
//!
//! A pair side is either one glyph (`ሀ`) or a class (`@ha`). A glyph belongs
//! to at most one class per side: its left-side class groups glyphs whose
//! right edge kerns alike (they sit on the left of a pair), its right-side
//! class groups glyphs whose left edge does.
//!
//! The value for two glyphs comes from the most specific pair, in this order:
//!
//! 1. glyph and glyph,
//! 2. glyph and the right glyph's class,
//! 3. the left glyph's class and glyph,
//! 4. class and class.
//!
//! A pair of the first three kinds that overrides a class pair is an
//! exception. Glyphs are keyed by the character they make.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Which side of a pair a class kerns on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KernSide {
    /// The glyph sits on the left of the pair; its right edge counts.
    Left,
    /// The glyph sits on the right of the pair; its left edge counts.
    Right,
}

/// One kerning value between two sides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernPair {
    /// A character, or `@` and a left-side class name.
    pub left: String,
    /// A character, or `@` and a right-side class name.
    pub right: String,
    /// Units added between the two, negative to tighten.
    pub value: i32,
}

/// Where a resolved value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KernSource {
    /// A class pair, or a glyph pair with no class pair under it.
    Pair,
    /// A glyph-level pair that overrides a class pair.
    Exception,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Kerning {
    /// Left-side classes by name: their members' right edges kern alike.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub left_classes: BTreeMap<String, Vec<char>>,
    /// Right-side classes by name: their members' left edges kern alike.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub right_classes: BTreeMap<String, Vec<char>>,
    /// Every pair, sorted by left then right.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pairs: Vec<KernPair>,
}

/// Two glyphs and their value.
pub type GlyphPair = (char, char, i32);
/// Two classes' members and their value.
pub type ClassPair<'a> = (&'a [char], &'a [char], i32);

/// A pair side, parsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key<'a> {
    Glyph(char),
    Class(&'a str),
}

/// `@name` is a class; a single character is a glyph.
pub fn parse_key(s: &str) -> Option<Key<'_>> {
    if let Some(name) = s.strip_prefix('@') {
        return (!name.is_empty()).then_some(Key::Class(name));
    }
    let mut chars = s.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Some(Key::Glyph(c)),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KernError {
    #[error("“{0}” is not a glyph or a class")]
    BadKey(String),
    #[error("No class “{0}”")]
    NoClass(String),
    #[error("A class needs a name")]
    EmptyName,
    #[error("There is already a class “{0}”")]
    NameTaken(String),
}

impl Kerning {
    pub fn is_empty(&self) -> bool {
        self.left_classes.is_empty() && self.right_classes.is_empty() && self.pairs.is_empty()
    }

    pub fn classes(&self, side: KernSide) -> &BTreeMap<String, Vec<char>> {
        match side {
            KernSide::Left => &self.left_classes,
            KernSide::Right => &self.right_classes,
        }
    }

    fn classes_mut(&mut self, side: KernSide) -> &mut BTreeMap<String, Vec<char>> {
        match side {
            KernSide::Left => &mut self.left_classes,
            KernSide::Right => &mut self.right_classes,
        }
    }

    /// The class a glyph kerns with on one side.
    pub fn class_of(&self, side: KernSide, c: char) -> Option<&str> {
        self.classes(side).iter().find(|(_, m)| m.contains(&c)).map(|(n, _)| n.as_str())
    }

    /// The value stored for exactly these two sides.
    pub fn pair(&self, left: &str, right: &str) -> Option<i32> {
        self.pairs.iter().find(|p| p.left == left && p.right == right).map(|p| p.value)
    }

    /// The value between two glyphs, and where it comes from.
    pub fn value(&self, l: char, r: char) -> Option<(i32, KernSource)> {
        let lc = self.class_of(KernSide::Left, l).map(|n| format!("@{n}"));
        let rc = self.class_of(KernSide::Right, r).map(|n| format!("@{n}"));
        let (ls, rs) = (l.to_string(), r.to_string());
        let class_pair = match (&lc, &rc) {
            (Some(a), Some(b)) => self.pair(a, b),
            _ => None,
        };
        let specific = self
            .pair(&ls, &rs)
            .or_else(|| rc.as_deref().and_then(|b| self.pair(&ls, b)))
            .or_else(|| lc.as_deref().and_then(|a| self.pair(a, &rs)));
        match (specific, class_pair) {
            (Some(v), Some(_)) => Some((v, KernSource::Exception)),
            (Some(v), None) => Some((v, KernSource::Pair)),
            (None, Some(v)) => Some((v, KernSource::Pair)),
            (None, None) => None,
        }
    }

    /// Set or remove (`None`) the value for two sides.
    pub fn set_pair(&mut self, left: &str, right: &str, value: Option<i32>) -> Result<(), KernError> {
        for (side, s) in [(KernSide::Left, left), (KernSide::Right, right)] {
            match parse_key(s) {
                None => return Err(KernError::BadKey(s.to_string())),
                Some(Key::Class(n)) if !self.classes(side).contains_key(n) => {
                    return Err(KernError::NoClass(n.to_string()))
                }
                _ => {}
            }
        }
        self.pairs.retain(|p| !(p.left == left && p.right == right));
        if let Some(value) = value {
            self.pairs.push(KernPair { left: left.to_string(), right: right.to_string(), value });
            self.pairs.sort_by(|a, b| (&a.left, &a.right).cmp(&(&b.left, &b.right)));
        }
        Ok(())
    }

    /// Create, change, rename or remove a class. Its members leave any other
    /// class on the same side. No members removes the class and its pairs.
    pub fn set_class(
        &mut self,
        side: KernSide,
        name: &str,
        members: &[char],
        rename: Option<&str>,
    ) -> Result<(), KernError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(KernError::EmptyName);
        }
        let new_name = rename.map(str::trim).unwrap_or(name);
        if new_name.is_empty() {
            return Err(KernError::EmptyName);
        }
        if new_name != name && self.classes(side).contains_key(new_name) {
            return Err(KernError::NameTaken(new_name.to_string()));
        }
        let mut seen = Vec::new();
        for &c in members {
            if !c.is_whitespace() && !seen.contains(&c) {
                seen.push(c);
            }
        }
        let classes = self.classes_mut(side);
        classes.remove(name);
        for m in classes.values_mut() {
            m.retain(|c| !seen.contains(c));
        }
        classes.retain(|_, m| !m.is_empty());
        let (old_key, new_key) = (format!("@{name}"), format!("@{new_name}"));
        let keep = !seen.is_empty();
        if keep {
            classes.insert(new_name.to_string(), seen);
        }
        // Classes emptied by the move lose their pairs, too.
        let live: Vec<String> = classes.keys().map(|n| format!("@{n}")).collect();
        for p in &mut self.pairs {
            let s = match side {
                KernSide::Left => &mut p.left,
                KernSide::Right => &mut p.right,
            };
            if keep && *s == old_key {
                *s = new_key.clone();
            }
        }
        self.pairs.retain(|p| {
            let s = match side {
                KernSide::Left => &p.left,
                KernSide::Right => &p.right,
            };
            !s.starts_with('@') || live.contains(s)
        });
        self.pairs.sort_by(|a, b| (&a.left, &a.right).cmp(&(&b.left, &b.right)));
        Ok(())
    }

    /// Every concrete glyph pair to write, most specific first, and the class
    /// pairs. Glyph-and-class pairs are spelled out per member, so that a
    /// font's class subtable only holds class-and-class pairs.
    pub fn flatten(&self) -> (Vec<GlyphPair>, Vec<ClassPair<'_>>) {
        let mut glyph_pairs: Vec<(char, char, i32)> = Vec::new();
        let mut push = |l: char, r: char, v: i32| {
            if !glyph_pairs.iter().any(|&(a, b, _)| a == l && b == r) {
                glyph_pairs.push((l, r, v));
            }
        };
        let mut class_pairs = Vec::new();
        let members = |side: KernSide, n: &str| self.classes(side).get(n).map(Vec::as_slice).unwrap_or(&[]);
        let parsed: Vec<_> = self
            .pairs
            .iter()
            .filter_map(|p| Some((parse_key(&p.left)?, parse_key(&p.right)?, p.value)))
            .collect();
        for &(l, r, v) in &parsed {
            if let (Key::Glyph(l), Key::Glyph(r)) = (l, r) {
                push(l, r, v);
            }
        }
        for &(l, r, v) in &parsed {
            if let (Key::Glyph(l), Key::Class(n)) = (l, r) {
                for &r in members(KernSide::Right, n) {
                    push(l, r, v);
                }
            }
        }
        for &(l, r, v) in &parsed {
            if let (Key::Class(n), Key::Glyph(r)) = (l, r) {
                for &l in members(KernSide::Left, n) {
                    push(l, r, v);
                }
            }
        }
        for &(l, r, v) in &parsed {
            if let (Key::Class(a), Key::Class(b)) = (l, r) {
                class_pairs.push((members(KernSide::Left, a), members(KernSide::Right, b), v));
            }
        }
        (glyph_pairs, class_pairs)
    }
}
