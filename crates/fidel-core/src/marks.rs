//! Anchors, accented letters built from parts, and the mark features.
//!
//! A letter carries anchors where accents go (`top`, `bottom`, `ogonek`); an
//! accent carries the same name with an underscore (`_top`) where it joins.
//! An accented letter built from parts places each accent so its `_top`
//! meets the letter's `top`, then takes the accent's own `top` so a second
//! accent stacks on the first. The same anchors make the `mark` and `mkmk`
//! features, so a font positions accents on letters it has no glyph for.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::charset;
use crate::features::{fea_name, glyph_name};
use crate::geometry::{Contour, Vec2};
use crate::order::Order;
use crate::project::Project;

/// Anchor names offered when adding one, with where each goes.
pub const ANCHOR_PRESETS: [&str; 8] =
    ["top", "bottom", "ogonek", "center", "_top", "_bottom", "_ogonek", "_center"];

/// A glyph's outline, width and anchors.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GlyphShape {
    pub contours: Vec<Contour>,
    pub advance: f64,
    pub anchors: BTreeMap<String, Vec2>,
}

/// Composites inside composites stop here.
const DEPTH: usize = 4;

fn bounds(cs: &[Contour]) -> Option<(Vec2, Vec2)> {
    let mut it = cs.iter().filter_map(|c| c.bounds());
    let first = it.next()?;
    Some(it.fold((first.min, first.max), |(lo, hi), b| {
        (Vec2::new(lo.x.min(b.min.x), lo.y.min(b.min.y)), Vec2::new(hi.x.max(b.max.x), hi.y.max(b.max.y)))
    }))
}

/// Where a preset anchor goes on a drawing.
pub fn preset_position(name: &str, contours: &[Contour], advance: f64) -> Vec2 {
    let (lo, hi) = bounds(contours).unwrap_or((Vec2::ZERO, Vec2::new(advance, 0.0)));
    let cx = ((lo.x + hi.x) / 2.0).round();
    match name {
        "top" => Vec2::new(cx, hi.y.round()),
        "bottom" => Vec2::new(cx, 0.0),
        "ogonek" => Vec2::new(hi.x.round(), 0.0),
        "center" => Vec2::new(cx, ((lo.y + hi.y) / 2.0).round()),
        "_top" => Vec2::new(cx, lo.y.round()),
        "_bottom" => Vec2::new(cx, hi.y.round()),
        "_ogonek" => Vec2::new(hi.x.round(), hi.y.round()),
        "_center" => Vec2::new(cx, ((lo.y + hi.y) / 2.0).round()),
        _ => Vec2::new(cx, ((lo.y + hi.y) / 2.0).round()),
    }
}

impl Project {
    /// The fidel for a character: its family and order.
    fn fidel_of(&self, c: char) -> Option<(&crate::fidel::Family, Order)> {
        self.families
            .values()
            .find_map(|f| f.fidels.iter().find(|(_, fi)| fi.codepoint == Some(c)).map(|(o, _)| (f, *o)))
    }

    /// The anchors of the glyph for a character. A fidel has its base's.
    pub fn glyph_anchors(&self, c: char) -> BTreeMap<String, Vec2> {
        if let Some(s) = self.symbols.values().find(|s| s.codepoint == c) {
            if !s.built_from.is_empty() {
                return self
                    .compose_at(s.built_from[0], &s.built_from[1..], 0)
                    .map(|g| g.anchors)
                    .unwrap_or_default();
            }
            return s.anchors.clone();
        }
        self.fidel_of(c).map(|(f, o)| self.fidel_anchors(f, o)).unwrap_or_default()
    }

    /// A fidel's anchors: its own when set, else its base's.
    pub fn fidel_anchors(&self, f: &crate::fidel::Family, order: Order) -> BTreeMap<String, Vec2> {
        f.fidels
            .get(&order)
            .and_then(|fi| fi.anchors.clone())
            .or_else(|| self.bases.get(&f.base).map(|b| b.anchors.clone()))
            .unwrap_or_default()
    }

    /// The glyph for a character: outline, width and anchors.
    pub fn glyph_shape(&self, c: char) -> Option<GlyphShape> {
        self.shape_at(c, 0)
    }

    fn shape_at(&self, c: char, depth: usize) -> Option<GlyphShape> {
        if depth > DEPTH {
            return None;
        }
        if let Some(s) = self.symbols.values().find(|s| s.codepoint == c) {
            if !s.built_from.is_empty() {
                return self.compose_at(s.built_from[0], &s.built_from[1..], depth + 1);
            }
            return Some(GlyphShape {
                contours: self.symbol_outline(&s.id),
                advance: s.advance_width,
                anchors: s.anchors.clone(),
            });
        }
        let (f, order) = self.fidel_of(c)?;
        let r = self.resolve(&f.id, order).ok()?;
        Some(GlyphShape {
            contours: r.contours.into_iter().map(|c| c.contour).collect(),
            advance: r.advance_width,
            anchors: self.fidel_anchors(f, order),
        })
    }

    /// A letter with accents placed on it by their anchors. An accent with
    /// no matching anchor sits centred above the letter (below for a
    /// cedilla, on the right foot for an ogonek).
    pub fn compose(&self, base: char, marks: &[char]) -> Option<GlyphShape> {
        self.compose_at(base, marks, 0)
    }

    fn compose_at(&self, base: char, marks: &[char], depth: usize) -> Option<GlyphShape> {
        // Accents above i and j sit on the dotless forms when they are drawn.
        let above = marks.iter().any(|m| !charset::accent_below(*m));
        let dotless = match base {
            'i' => Some('\u{0131}'),
            'j' => Some('\u{0237}'),
            _ => None,
        };
        let base = match dotless {
            Some(d) if above && self.shape_at(d, depth + 1).is_some_and(|s| !s.contours.is_empty()) => d,
            _ => base,
        };
        let mut shape = self.shape_at(base, depth + 1)?;
        for &m in marks {
            let Some(mark) = self.shape_at(m, depth + 1) else { continue };
            if mark.contours.is_empty() {
                continue;
            }
            let Some((name, shift)) = self.attach(&shape, &mark, m) else { continue };
            for c in &mark.contours {
                let mut c = c.clone();
                c.translate(shift);
                shape.contours.push(c);
            }
            // The accent's own anchors carry on: a second accent stacks.
            for (n, at) in &mark.anchors {
                if !n.starts_with('_') {
                    shape.anchors.insert(n.clone(), *at + shift);
                }
            }
            if !mark.anchors.contains_key(&name) {
                if let Some((_, hi)) = bounds(&shape.contours) {
                    if name == "top" {
                        let x = shape.anchors.get("top").map_or(hi.x, |a| a.x);
                        shape.anchors.insert("top".into(), Vec2::new(x, hi.y));
                    }
                }
            }
        }
        for (i, c) in shape.contours.iter_mut().enumerate() {
            c.id = i as u32;
        }
        Some(shape)
    }

    /// Where an accent goes on a letter: the anchor it joins at, and how far
    /// the accent moves. With no matching anchors it sits centred above the
    /// letter (below for a cedilla, on the right foot for an ogonek).
    fn attach(&self, base: &GlyphShape, mark: &GlyphShape, m: char) -> Option<(String, Vec2)> {
        let joined = mark.anchors.iter().find_map(|(n, at)| {
            let name = n.strip_prefix('_')?;
            base.anchors.get(name).map(|to| (name.to_string(), *to - *at))
        });
        if joined.is_some() {
            return joined;
        }
        let (blo, bhi) = bounds(&base.contours).unwrap_or((Vec2::ZERO, Vec2::new(base.advance, 0.0)));
        let (mlo, mhi) = bounds(&mark.contours)?;
        let gap = f64::from(self.metrics.units_per_em) * 0.04;
        let cx = (blo.x + bhi.x) / 2.0 - (mlo.x + mhi.x) / 2.0;
        Some(match m {
            '\u{0328}' => ("ogonek".to_string(), Vec2::new(bhi.x - mhi.x, gap - mhi.y)),
            c if charset::accent_below(c) => {
                ("bottom".to_string(), Vec2::new(cx, blo.y.min(0.0) - mhi.y - gap))
            }
            _ => ("top".to_string(), Vec2::new(cx, bhi.y + gap - mlo.y)),
        })
    }

    /// A partner glyph placed against a drawing for preview: an accent on
    /// a letter, or a letter under an accent. `own` is the drawing open now.
    pub fn mark_preview(
        &self,
        own: &GlyphShape,
        own_char: Option<char>,
        partner: char,
    ) -> Option<Vec<Contour>> {
        let other = self.glyph_shape(partner)?;
        let own_is_mark = own.anchors.keys().any(|k| k.starts_with('_'))
            || own_char.is_some_and(|c| {
                (0x300..0x370).contains(&(c as u32)) || (0x135D..=0x135F).contains(&(c as u32))
            });
        let (shift, contours) = if own_is_mark {
            let (_, d) = self.attach(&other, own, own_char.unwrap_or('\u{0301}'))?;
            (Vec2::new(-d.x, -d.y), other.contours)
        } else {
            let (_, d) = self.attach(own, &other, partner)?;
            (d, other.contours)
        };
        Some(
            contours
                .into_iter()
                .map(|mut c| {
                    c.translate(shift);
                    c
                })
                .collect(),
        )
    }

    /// Build every accented letter that is not drawn from its base letter
    /// and accents. Returns how many were set up.
    pub fn build_accents(&mut self) -> usize {
        let mut n = 0;
        for s in self.symbols.values_mut() {
            if !s.contours.is_empty() || !s.built_from.is_empty() {
                continue;
            }
            if let Some((base, marks)) = charset::recipe(s.codepoint) {
                s.built_from = std::iter::once(base).chain(marks.iter().copied()).collect();
                n += 1;
            }
        }
        n
    }

    /// Turn a built letter into a drawing of its own.
    pub fn decompose_symbol(&mut self, id: &str) -> Option<()> {
        let s = self.symbols.get(id)?;
        if s.built_from.is_empty() {
            return Some(());
        }
        let shape = self.compose(s.built_from[0], &s.built_from[1..])?;
        let s = self.symbols.get_mut(id)?;
        s.contours = shape.contours;
        s.anchors = shape.anchors;
        s.advance_width = shape.advance;
        s.built_from.clear();
        Some(())
    }

    /// The `markClass` definitions and the `mark` and `mkmk` features, for
    /// the characters `has` keeps. Empty when no accent has an anchor.
    pub fn mark_features(&self, chars: &[char]) -> String {
        let anchors: Vec<(char, BTreeMap<String, Vec2>)> =
            chars.iter().map(|&c| (c, self.glyph_anchors(c))).filter(|(_, a)| !a.is_empty()).collect();
        let is_mark = |a: &BTreeMap<String, Vec2>| a.keys().any(|k| k.starts_with('_'));
        // Anchor names some accent joins with.
        let mut classes: Vec<String> = Vec::new();
        for (_, a) in anchors.iter().filter(|(_, a)| is_mark(a)) {
            for k in a.keys().filter_map(|k| k.strip_prefix('_')) {
                if !classes.iter().any(|c| c == k) {
                    classes.push(k.to_string());
                }
            }
        }
        if classes.is_empty() {
            return String::new();
        }
        let pt = |v: &Vec2| format!("<anchor {} {}>", v.x.round() as i64, v.y.round() as i64);
        let class = |n: &str| format!("@MC_{}", fea_name(n));
        let mut t = String::new();
        for (c, a) in anchors.iter().filter(|(_, a)| is_mark(a)) {
            for (k, v) in a.iter().filter(|(k, _)| k.starts_with('_')) {
                t.push_str(&format!("markClass {} {} {};\n", glyph_name(*c), pt(v), class(&k[1..])));
            }
        }
        let attach = |a: &BTreeMap<String, Vec2>| -> String {
            classes.iter().filter_map(|n| a.get(n).map(|v| format!(" {} mark {}", pt(v), class(n)))).collect()
        };
        let mut mark = String::new();
        let mut mkmk = String::new();
        for (c, a) in &anchors {
            let s = attach(a);
            if s.is_empty() {
                continue;
            }
            if is_mark(a) {
                mkmk.push_str(&format!("  pos mark {}{s};\n", glyph_name(*c)));
            } else {
                mark.push_str(&format!("  pos base {}{s};\n", glyph_name(*c)));
            }
        }
        if !mark.is_empty() {
            t.push_str(&format!("feature mark {{\n{mark}}} mark;\n"));
        }
        if !mkmk.is_empty() {
            t.push_str(&format!("feature mkmk {{\n{mkmk}}} mkmk;\n"));
        }
        t
    }
}

impl Project {
    /// Replace the anchors of a base or a symbol.
    pub fn set_anchors(
        &mut self,
        target: &crate::project::DrawingTarget,
        anchors: BTreeMap<String, Vec2>,
    ) -> Result<(), crate::project::ModelError> {
        use crate::project::{DrawingTarget, ModelError};
        let anchors: BTreeMap<String, Vec2> = anchors
            .into_iter()
            .map(|(k, v)| (k.trim().to_string(), v))
            .filter(|(k, _)| !k.is_empty())
            .collect();
        match target {
            DrawingTarget::Base(id) => {
                self.bases.get_mut(id).ok_or_else(|| ModelError::UnknownBase(id.clone()))?.anchors = anchors;
            }
            DrawingTarget::Symbol(id) => {
                self.symbols.get_mut(id).ok_or_else(|| ModelError::UnknownSymbol(id.clone()))?.anchors =
                    anchors;
            }
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id)?;
                self.fidel_mut(&family, order)?.anchors = Some(anchors);
            }
            _ => return Err(ModelError::NoMetrics),
        }
        Ok(())
    }

    /// Build a symbol from a base letter and accents, or (empty) draw it.
    pub fn set_built_from(&mut self, id: &str, parts: Vec<char>) -> Result<(), crate::project::ModelError> {
        let s =
            self.symbols.get_mut(id).ok_or_else(|| crate::project::ModelError::UnknownSymbol(id.into()))?;
        s.built_from = parts.into_iter().filter(|&c| c != s.codepoint && !c.is_whitespace()).collect();
        Ok(())
    }
}
