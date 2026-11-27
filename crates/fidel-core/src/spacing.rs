//! Automatic spacing and kerning by white area, and letter and pair
//! frequencies read from a text corpus.
//!
//! Spacing measures, row by row through the Pa band, how far the white
//! reaches into each side of a glyph (no deeper than `depth`), and sets the
//! sidebearings so every side has the same average white as the reference
//! glyph. Kerning looks at the closest approach of two glyphs set side by
//! side and pulls in or pushes out the pairs that stand out from the rest.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::geometry::{Contour, Vec2};
use crate::metric_keys::Side;
use crate::project::{DrawingTarget, ModelError, Project};

/// Settings kept with the project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spacing {
    /// The glyph whose spacing the others match, spaced by hand.
    pub reference: char,
    /// How far into a counter or an opening the white is counted, in units.
    pub depth: f64,
    /// How much of a pair's difference from the usual gap is kerned, 0 to 1.
    pub strength: f64,
    /// Kerning values smaller than this are left out.
    pub min_kern: f64,
    /// How many of the most frequent pairs to kern.
    pub pair_count: usize,
    /// Letter counts from the corpus, most frequent first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub letters: Vec<(char, u32)>,
    /// Pair counts from the corpus, most frequent first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pairs: Vec<(String, u32)>,
}

impl Default for Spacing {
    fn default() -> Self {
        Spacing {
            reference: 'ሀ',
            depth: 120.0,
            strength: 0.6,
            min_kern: 8.0,
            pair_count: 300,
            letters: Vec::new(),
            pairs: Vec::new(),
        }
    }
}

impl Spacing {
    pub fn is_default(&self) -> bool {
        *self == Spacing::default()
    }
}

/// Letters and adjacent pairs of `text`, most frequent first. Spaces and
/// punctuation break pairs; only `keep` characters are counted.
pub fn frequencies(text: &str, keep: &dyn Fn(char) -> bool) -> (Vec<(char, u32)>, Vec<(String, u32)>) {
    let mut letters: HashMap<char, u32> = HashMap::new();
    let mut pairs: HashMap<(char, char), u32> = HashMap::new();
    let mut prev: Option<char> = None;
    for c in text.chars() {
        if c.is_whitespace() || !keep(c) {
            prev = None;
            continue;
        }
        *letters.entry(c).or_default() += 1;
        if let Some(p) = prev {
            *pairs.entry((p, c)).or_default() += 1;
        }
        prev = Some(c);
    }
    let mut l: Vec<(char, u32)> = letters.into_iter().collect();
    l.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut p: Vec<(String, u32)> = pairs.into_iter().map(|((a, b), n)| (format!("{a}{b}"), n)).collect();
    p.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    p.truncate(2000);
    (l, p)
}

/// The outline as polygons, curves sampled.
fn polygons(contours: &[Contour]) -> Vec<Vec<Vec2>> {
    contours.iter().filter(|c| !c.open).map(crate::pathops::flatten).filter(|p| p.len() > 2).collect()
}

/// For each row from `y0` to `y1`, the leftmost and rightmost ink.
pub fn profile(contours: &[Contour], y0: f64, y1: f64, step: f64) -> Vec<Option<(f64, f64)>> {
    let polys = polygons(contours);
    let mut out = Vec::new();
    let mut y = y0 + step / 2.0;
    while y < y1 {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for p in &polys {
            let n = p.len();
            for i in 0..n {
                let (a, b) = (p[i], p[(i + 1) % n]);
                if (a.y > y) != (b.y > y) {
                    let x = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
                    lo = lo.min(x);
                    hi = hi.max(x);
                }
            }
        }
        out.push(lo.is_finite().then_some((lo, hi)));
        y += step;
    }
    out
}

/// The average white reaching into the left and right of an outline past
/// its extremes, each row counted no deeper than `depth`.
fn inner_white(rows: &[Option<(f64, f64)>], depth: f64) -> Option<(f64, f64)> {
    let min = rows.iter().flatten().map(|r| r.0).fold(f64::INFINITY, f64::min);
    let max = rows.iter().flatten().map(|r| r.1).fold(f64::NEG_INFINITY, f64::max);
    if !min.is_finite() || rows.is_empty() {
        return None;
    }
    let n = rows.len() as f64;
    let left = rows.iter().map(|r| r.map_or(depth, |(lo, _)| (lo - min).min(depth))).sum::<f64>() / n;
    let right = rows.iter().map(|r| r.map_or(depth, |(_, hi)| (max - hi).min(depth))).sum::<f64>() / n;
    Some((left, right))
}

const STEP: f64 = 5.0;

/// A proposed kerning value for a pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KernProposal {
    pub left: char,
    pub right: char,
    pub value: i32,
    /// How often the pair occurs in the corpus.
    pub count: u32,
}

impl Project {
    fn band(&self) -> (f64, f64) {
        let m = &self.metrics;
        let (lo, hi) = (m.pa_bottom.min(0.0), m.pa_top);
        if hi > lo {
            (lo, hi)
        } else {
            (0.0, 700.0)
        }
    }

    /// The average white each side of `c` should have: the reference's.
    fn target_white(&self, depth: f64) -> Option<f64> {
        let (y0, y1) = self.band();
        let r = self.spacing.reference;
        let shape = self.glyph_shape(r)?;
        let rows = profile(&shape.contours, y0, y1, STEP);
        let (l, rr) = inner_white(&rows, depth)?;
        let (lsb, rsb, _) = crate::metric_keys::measure(&shape.contours, shape.advance)?;
        Some(((lsb + l) + (rsb + rr)) / 2.0)
    }

    /// Space bases and symbols (all, or those named) to match the reference.
    /// Sides set by a metric key are left to the key. Returns how many
    /// glyphs changed.
    pub fn auto_space(&mut self, only: Option<&[DrawingTarget]>) -> Result<usize, ModelError> {
        let depth = self.spacing.depth.max(0.0);
        let Some(target) = self.target_white(depth) else {
            return Err(ModelError::NotSpaced(self.spacing.reference));
        };
        let (y0, y1) = self.band();
        let reference = self.spacing.reference;
        let mut todo: Vec<(crate::metric_keys::Keyed, Vec<Contour>, crate::metric_keys::MetricKeys)> =
            Vec::new();
        for b in self.bases.values() {
            todo.push((
                crate::metric_keys::Keyed::Base(b.id.clone()),
                b.contours.clone(),
                b.metric_keys.clone(),
            ));
        }
        for s in self.symbols.values().filter(|s| s.built_from.is_empty()) {
            todo.push((
                crate::metric_keys::Keyed::Symbol(s.id.clone()),
                self.symbol_outline(&s.id),
                s.metric_keys.clone(),
            ));
        }
        let mut changed = 0;
        for (who, contours, keys) in todo {
            let t = match &who {
                crate::metric_keys::Keyed::Base(id) => DrawingTarget::Base(id.clone()),
                crate::metric_keys::Keyed::Symbol(id) => DrawingTarget::Symbol(id.clone()),
            };
            if only.is_some_and(|o| !o.contains(&t)) {
                continue;
            }
            // The reference stays as drawn.
            if self.char_of_keyed(&who) == Some(reference) {
                continue;
            }
            let rows = profile(&contours, y0, y1, STEP);
            let Some((l, r)) = inner_white(&rows, depth) else { continue };
            let mut moved = false;
            if keys.left.as_deref().is_none_or(|k| k.trim().is_empty()) {
                moved |= self.set_metric(&who, Side::Left, (target - l).round());
            }
            if keys.right.as_deref().is_none_or(|k| k.trim().is_empty())
                && keys.width.as_deref().is_none_or(|k| k.trim().is_empty())
            {
                moved |= self.set_metric(&who, Side::Right, (target - r).round());
            }
            if moved {
                changed += 1;
            }
        }
        self.after_edit();
        Ok(changed)
    }

    fn char_of_keyed(&self, who: &crate::metric_keys::Keyed) -> Option<char> {
        match who {
            crate::metric_keys::Keyed::Symbol(id) => self.symbols.get(id).map(|s| s.codepoint),
            crate::metric_keys::Keyed::Base(id) => self
                .families
                .values()
                .find(|f| &f.base == id)
                .and_then(|f| f.fidels.get(&crate::order::Order::Giiz))
                .and_then(|fi| fi.codepoint),
        }
    }

    /// The closest approach of `l` and `r` set side by side, row by row,
    /// each side counted no deeper than `depth`; None when they share no row.
    fn pair_gap(&self, l: char, r: char, depth: f64) -> Option<f64> {
        let (y0, y1) = self.band();
        let a = self.glyph_shape(l)?;
        let b = self.glyph_shape(r)?;
        let pa = profile(&a.contours, y0, y1, STEP);
        let pb = profile(&b.contours, y0, y1, STEP);
        let amax = pa.iter().flatten().map(|x| x.1).fold(f64::NEG_INFINITY, f64::max);
        let bmin = pb.iter().flatten().map(|x| x.0).fold(f64::INFINITY, f64::min);
        if !amax.is_finite() || !bmin.is_finite() {
            return None;
        }
        let base = (a.advance - amax) + bmin;
        // A short window of rows, so a single sharp point does not decide.
        let gaps: Vec<f64> = pa
            .iter()
            .zip(&pb)
            .map(|(x, y)| match (x, y) {
                (Some((_, hi)), Some((lo, _))) => base + (amax - hi).min(depth) + (lo - bmin).min(depth),
                _ => f64::INFINITY,
            })
            .collect();
        let w = 6usize;
        let mut best = f64::INFINITY;
        for i in 0..gaps.len() {
            let win = &gaps[i..(i + w).min(gaps.len())];
            if win.iter().all(|g| g.is_finite()) {
                best = best.min(win.iter().sum::<f64>() / win.len() as f64);
            }
        }
        best.is_finite().then_some(best)
    }

    /// Kerning for the most frequent pairs of the corpus: pairs whose closest
    /// approach differs from the usual one are moved part of the way.
    pub fn propose_kerning(&self) -> Vec<KernProposal> {
        let s = &self.spacing;
        let depth = s.depth.max(0.0);
        let mut gaps: Vec<(char, char, u32, f64)> = Vec::new();
        for (pair, count) in s.pairs.iter().take(s.pair_count) {
            let mut cs = pair.chars();
            let (Some(l), Some(r)) = (cs.next(), cs.next()) else { continue };
            if let Some(g) = self.pair_gap(l, r, depth) {
                gaps.push((l, r, *count, g));
            }
        }
        if gaps.is_empty() {
            return Vec::new();
        }
        // The usual gap, weighted by how often each pair occurs.
        let mut sorted: Vec<(f64, u32)> = gaps.iter().map(|g| (g.3, g.2)).collect();
        sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
        let total: u64 = sorted.iter().map(|g| u64::from(g.1)).sum();
        let mut acc = 0u64;
        let mut usual = sorted[0].0;
        for (g, n) in &sorted {
            acc += u64::from(*n);
            if acc * 2 >= total {
                usual = *g;
                break;
            }
        }
        let cap = depth.max(40.0);
        let mut out: Vec<KernProposal> = gaps
            .into_iter()
            .filter_map(|(l, r, count, g)| {
                let v = ((usual - g) * s.strength).clamp(-cap, cap).round();
                (v.abs() >= s.min_kern).then_some(KernProposal { left: l, right: r, value: v as i32, count })
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count));
        out
    }

    /// Write proposed kerning as glyph pairs. Pairs kerned by hand stay.
    pub fn apply_kerning(&mut self, proposals: &[KernProposal]) -> usize {
        let mut n = 0;
        for p in proposals {
            let (l, r) = (p.left.to_string(), p.right.to_string());
            if self.kerning.pair(&l, &r).is_some() {
                continue;
            }
            if self.kerning.set_pair(&l, &r, Some(p.value)).is_ok() {
                n += 1;
            }
        }
        n
    }

    /// Read a corpus: keep the letter and pair counts of characters the font covers.
    pub fn read_corpus(&mut self, text: &str) {
        let (letters, pairs) = frequencies(text, &|c| self.glyph_shape(c).is_some());
        self.spacing.letters = letters;
        self.spacing.pairs = pairs;
    }
}
