//! Metric keys: a sidebearing or width set by another glyph's, such as
//! `=ሀ`, `=ሀ+10`, `=|ሀ` (ሀ's opposite side) or a plain `=40`. Kept on bases
//! and symbols; the fidel built from a base follow it as usual.

use serde::{Deserialize, Serialize};

use crate::geometry::{bounds_of, Contour, Vec2};
use crate::order::Order;
use crate::project::{ModelError, Project};

/// The keys on one drawing. Empty strings count as unset.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MetricKeys {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<String>,
}

impl MetricKeys {
    pub fn is_empty(&self) -> bool {
        [&self.left, &self.right, &self.width]
            .iter()
            .all(|k| k.as_deref().is_none_or(|s| s.trim().is_empty()))
    }

    /// Unset keys that are blank.
    pub fn tidy(mut self) -> Self {
        for k in [&mut self.left, &mut self.right, &mut self.width] {
            if k.as_deref().is_some_and(|s| s.trim().is_empty()) {
                *k = None;
            }
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Width,
}

/// A parsed key.
#[derive(Debug, Clone, PartialEq)]
pub struct Expr {
    /// The glyph it follows: a character or a glyph name. `None` for a plain number.
    pub reference: Option<String>,
    /// `|`: the reference's other side.
    pub opposite: bool,
    pub op: Option<(char, f64)>,
    pub number: Option<f64>,
}

/// Read `=ሀ`, `=ሀ+10`, `=|ሀ`, `=ሀ*1.5`, `=40` (the `=` is optional).
pub fn parse(key: &str) -> Result<Expr, String> {
    let s = key.trim();
    let s = s.strip_prefix('=').unwrap_or(s).trim();
    if s.is_empty() {
        return Err("Empty key".into());
    }
    if let Ok(n) = s.parse::<f64>() {
        return Ok(Expr { reference: None, opposite: false, op: None, number: Some(n) });
    }
    let (opposite, s) = match s.strip_prefix('|') {
        Some(rest) => (true, rest.trim_start()),
        None => (false, s),
    };
    // The reference runs up to an operator.
    let end = s.char_indices().find(|(i, c)| *i > 0 && matches!(c, '+' | '-' | '*' | '/')).map(|(i, _)| i);
    let (name, rest) = match end {
        Some(i) => (s[..i].trim(), s[i..].trim()),
        None => (s.trim(), ""),
    };
    if name.is_empty() || name.contains(char::is_whitespace) {
        return Err(format!("“{key}” does not name a glyph"));
    }
    let op = if rest.is_empty() {
        None
    } else {
        let mut chars = rest.chars();
        let o = chars.next().expect("not empty");
        let n: f64 =
            chars.as_str().trim().parse().map_err(|_| format!("“{key}”: a number must follow {o}"))?;
        Some((o, n))
    };
    Ok(Expr { reference: Some(name.to_string()), opposite, op, number: None })
}

/// Left sidebearing, right sidebearing and width of an outline.
pub fn measure(contours: &[Contour], advance: f64) -> Option<(f64, f64, f64)> {
    let b = bounds_of(contours)?;
    Some((b.min.x, advance - b.max.x, advance))
}

/// What a drawing with keys is, for [`Project::apply_metric_keys`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Keyed {
    Base(String),
    Symbol(String),
}

impl Project {
    /// The character a reference names: itself, or a glyph name `uni1200`.
    fn reference_char(name: &str) -> Option<char> {
        let mut chars = name.chars();
        if let (Some(c), None) = (chars.next(), chars.clone().next()) {
            return Some(c);
        }
        let hex = name.strip_prefix("uni").or_else(|| name.strip_prefix('u'))?;
        char::from_u32(u32::from_str_radix(hex, 16).ok()?)
    }

    /// Sidebearings and width of the glyph for `c`, as it is now.
    pub fn glyph_metrics(&self, c: char) -> Option<(f64, f64, f64)> {
        if let Some(s) = self.symbols.values().find(|s| s.codepoint == c) {
            return measure(&self.symbol_outline(&s.id), s.advance_width);
        }
        for f in self.families.values() {
            for (order, fidel) in &f.fidels {
                if fidel.codepoint == Some(c) {
                    if *order == Order::Giiz {
                        let b = self.bases.get(&f.base)?;
                        return measure(&b.contours, b.advance_width);
                    }
                    let r = self.resolve(&f.id, *order).ok()?;
                    let contours: Vec<Contour> = r.contours.into_iter().map(|c| c.contour).collect();
                    return measure(&contours, r.advance_width);
                }
            }
        }
        None
    }

    /// The value a key gives on `side`, or why it gives none.
    pub fn evaluate_key(&self, key: &str, side: Side) -> Result<f64, String> {
        let e = parse(key)?;
        let base = match (&e.reference, e.number) {
            (None, Some(n)) => return Ok(n),
            (Some(name), _) => {
                let c = Self::reference_char(name).ok_or_else(|| format!("No glyph “{name}”"))?;
                let (l, r, w) = self.glyph_metrics(c).ok_or_else(|| format!("{c} is not drawn yet"))?;
                match (side, e.opposite) {
                    (Side::Width, _) => w,
                    (Side::Left, false) | (Side::Right, true) => l,
                    (Side::Right, false) | (Side::Left, true) => r,
                }
            }
            (None, None) => return Err("Empty key".into()),
        };
        Ok(match e.op {
            Some(('+', n)) => base + n,
            Some(('-', n)) => base - n,
            Some(('*', n)) => base * n,
            Some(('/', n)) if n != 0.0 => base / n,
            Some((o, _)) => return Err(format!("Cannot use {o} here")),
            None => base,
        })
    }

    /// Set every keyed sidebearing and width from what it follows. Runs a few
    /// passes so chains settle; returns the keys that could not be applied.
    pub fn apply_metric_keys(&mut self) -> Vec<(Keyed, Side, String)> {
        let keyed: Vec<(Keyed, crate::metric_keys::MetricKeys)> = self
            .bases
            .values()
            .filter(|b| !b.metric_keys.is_empty())
            .map(|b| (Keyed::Base(b.id.clone()), b.metric_keys.clone()))
            .chain(
                self.symbols
                    .values()
                    .filter(|s| !s.metric_keys.is_empty())
                    .map(|s| (Keyed::Symbol(s.id.clone()), s.metric_keys.clone())),
            )
            .collect();
        if keyed.is_empty() {
            return Vec::new();
        }
        let mut errors = Vec::new();
        for pass in 0..4 {
            let mut changed = false;
            errors.clear();
            for (who, keys) in &keyed {
                for (side, key) in
                    [(Side::Left, &keys.left), (Side::Right, &keys.right), (Side::Width, &keys.width)]
                {
                    let Some(key) = key.as_deref().filter(|k| !k.trim().is_empty()) else { continue };
                    match self.evaluate_key(key, side) {
                        Ok(v) => changed |= self.set_metric(who, side, v.round()),
                        Err(e) => errors.push((who.clone(), side, e)),
                    }
                }
            }
            if !changed && pass > 0 {
                break;
            }
        }
        errors
    }

    /// Give every other master this drawing's sidebearings as they are in
    /// the master being edited. Returns how many masters changed.
    pub fn copy_metrics_to_masters(&mut self, target: &crate::DrawingTarget) -> Result<usize, ModelError> {
        let who = match target {
            crate::DrawingTarget::Base(id) => Keyed::Base(id.clone()),
            crate::DrawingTarget::Symbol(id) => Keyed::Symbol(id.clone()),
            _ => return Err(ModelError::NoMetrics),
        };
        let (contours, advance) = match &who {
            Keyed::Base(id) => {
                let b = self.bases.get(id).ok_or_else(|| ModelError::UnknownBase(id.clone()))?;
                (b.contours.clone(), b.advance_width)
            }
            Keyed::Symbol(id) => {
                let s = self.symbols.get(id).ok_or_else(|| ModelError::UnknownSymbol(id.clone()))?;
                (s.contours.clone(), s.advance_width)
            }
        };
        let Some((lsb, rsb, _)) = measure(&contours, advance) else { return Ok(0) };
        let back = self.design.active;
        let mut changed = 0;
        for m in 0..self.design.masters.len() {
            if m == back {
                continue;
            }
            let _ = self.switch_master(m);
            let moved = self.set_metric(&who, Side::Left, lsb.round())
                | self.set_metric(&who, Side::Right, rsb.round());
            if moved {
                changed += 1;
            }
        }
        let _ = self.switch_master(back);
        Ok(changed)
    }

    /// Give every other master the kerning of the master being edited.
    /// Returns how many masters changed.
    pub fn copy_kerning_to_masters(&mut self) -> usize {
        let pairs = self.kerning.pairs.clone();
        let back = self.design.active;
        let mut changed = 0;
        for m in 0..self.design.masters.len() {
            if m == back {
                continue;
            }
            let _ = self.switch_master(m);
            if self.kerning.pairs != pairs {
                self.kerning.pairs = pairs.clone();
                changed += 1;
            }
        }
        let _ = self.switch_master(back);
        changed
    }

    /// Set one metric of a drawing; returns whether anything moved.
    fn set_metric(&mut self, who: &Keyed, side: Side, v: f64) -> bool {
        let (contours, advance, components, anchors) = match who {
            Keyed::Base(id) => {
                let Some(b) = self.bases.get_mut(id) else { return false };
                (&mut b.contours, &mut b.advance_width, Some(&mut b.components), Some(&mut b.anchors))
            }
            Keyed::Symbol(id) => {
                let Some(s) = self.symbols.get_mut(id) else { return false };
                (&mut s.contours, &mut s.advance_width, Some(&mut s.components), Some(&mut s.anchors))
            }
        };
        let Some(b) = bounds_of(contours.iter()) else { return false };
        match side {
            Side::Left => {
                let dx = v - b.min.x;
                if dx.abs() < 0.5 {
                    return false;
                }
                for c in contours.iter_mut() {
                    c.translate(Vec2::new(dx, 0.0));
                }
                if let Some(refs) = components {
                    for r in refs.iter_mut() {
                        r.at.x += dx;
                    }
                }
                if let Some(anchors) = anchors {
                    for a in anchors.values_mut() {
                        a.x += dx;
                    }
                }
                *advance += dx;
                true
            }
            Side::Right => {
                let w = b.max.x + v;
                let moved = (w - *advance).abs() >= 0.5;
                *advance = w;
                moved
            }
            Side::Width => {
                let moved = (v - *advance).abs() >= 0.5;
                *advance = v.max(0.0);
                moved
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_keys() {
        assert_eq!(parse("=40").unwrap().number, Some(40.0));
        let e = parse("=ሀ+10").unwrap();
        assert_eq!((e.reference.as_deref(), e.op), (Some("ሀ"), Some(('+', 10.0))));
        let e = parse("|uni1200 * 1.5").unwrap();
        assert!(e.opposite);
        assert_eq!((e.reference.as_deref(), e.op), (Some("uni1200"), Some(('*', 1.5))));
        assert!(parse("=").is_err());
        assert!(parse("=ሀ+").is_err());
        assert!(parse("=a b").is_err());
    }
}
