//! Masters, axes and instances: the design space.
//!
//! A project has one or more masters. The structure (families, rules, part
//! tags, classes) is shared; each master has its own drawings: base and
//! symbol outlines and widths, alteration and component outlines, attach
//! offsets, nudges and hand-drawn fidel, kerning values and backgrounds.
//!
//! The active master's drawings live in the project itself, so every edit
//! works on it unchanged. The others wait as [`MasterLayer`]s; switching swaps
//! them. An instance anywhere in the design space interpolates the masters'
//! layers with the OpenType variation model, the one variable fonts use.
//!
//! Axis values are in user units (weight 400, 700). Masters sit in design
//! units, which an axis map turns user units into; with no map the two are
//! the same.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::base::BaseId;
use crate::component::ComponentRef;
use crate::fidel::{FamilyId, FidelState};
use crate::geometry::{Contour, Vec2};
use crate::order::Order;
use crate::project::Project;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Axis {
    /// Four letters: `wght`, `wdth`, `ital`, `slnt`, `opsz` or your own.
    pub tag: String,
    pub name: String,
    pub min: f64,
    pub default: f64,
    pub max: f64,
    /// User value to design value, sorted by user value. Empty is identity.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub map: Vec<[f64; 2]>,
}

impl Axis {
    /// A user value in design units.
    pub fn to_design(&self, user: f64) -> f64 {
        piecewise(&self.map, user)
    }

    /// A design value from -1 (min) through 0 (default) to 1 (max).
    pub fn normalize_design(&self, design: f64) -> f64 {
        let (min, def, max) =
            (self.to_design(self.min), self.to_design(self.default), self.to_design(self.max));
        if design < def {
            if def - min <= 0.0 {
                0.0
            } else {
                (design - def) / (def - min)
            }
        } else if design > def {
            if max - def <= 0.0 {
                0.0
            } else {
                (design - def) / (max - def)
            }
        } else {
            0.0
        }
    }

    /// A user value normalized without the map: what fvar sees.
    pub fn normalize_user(&self, user: f64) -> f64 {
        if user < self.default {
            if self.default > self.min {
                (user - self.default) / (self.default - self.min)
            } else {
                0.0
            }
        } else if user > self.default && self.max > self.default {
            (user - self.default) / (self.max - self.default)
        } else {
            0.0
        }
    }
}

/// Straight lines between the points; flat beyond the ends.
fn piecewise(map: &[[f64; 2]], x: f64) -> f64 {
    if map.is_empty() {
        return x;
    }
    if x <= map[0][0] {
        return map[0][1] + (x - map[0][0]);
    }
    for w in map.windows(2) {
        let ([x0, y0], [x1, y1]) = (w[0], w[1]);
        if x <= x1 {
            return if x1 == x0 { y1 } else { y0 + (x - x0) * (y1 - y0) / (x1 - x0) };
        }
    }
    let [xl, yl] = map[map.len() - 1];
    yl + (x - xl)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Master {
    pub id: String,
    pub name: String,
    /// Design units by axis tag. A missing axis is at its default.
    #[serde(default)]
    pub location: BTreeMap<String, f64>,
    /// This master's drawings, while another master is active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<MasterLayer>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Instance {
    pub name: String,
    /// User units by axis tag.
    #[serde(default)]
    pub location: BTreeMap<String, f64>,
    /// Exported as its own font, besides being named in the variable font.
    #[serde(default = "yes")]
    pub export: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Designspace {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub axes: Vec<Axis>,
    /// Empty means one master, the project itself.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub masters: Vec<Master>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instances: Vec<Instance>,
    /// Which master's drawings are in the project now.
    #[serde(default)]
    pub active: usize,
    /// Extra drawings of single glyphs between the masters.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub braces: Vec<crate::braces::Brace>,
    /// For an instance: where it sits, normalized per axis. Parts that
    /// follow a font axis read it.
    #[serde(skip)]
    pub at: Option<Vec<f64>>,
}

impl Designspace {
    pub fn is_empty(&self) -> bool {
        self.axes.is_empty() && self.masters.is_empty() && self.instances.is_empty()
    }

    /// A master's location, normalized per axis.
    pub fn master_location(&self, m: &Master) -> Vec<f64> {
        self.axes
            .iter()
            .map(|a| {
                a.normalize_design(m.location.get(&a.tag).copied().unwrap_or_else(|| a.to_design(a.default)))
            })
            .collect()
    }

    /// A location in user units, normalized per axis.
    pub fn user_location(&self, user: &BTreeMap<String, f64>) -> Vec<f64> {
        self.axes
            .iter()
            .map(|a| a.normalize_design(a.to_design(user.get(&a.tag).copied().unwrap_or(a.default))))
            .collect()
    }

    /// Where the project's drawings sit now, normalized, by axis tag: the
    /// instance's location, or the active master's.
    pub fn font_location(&self) -> Vec<(String, f64)> {
        let loc = self
            .at
            .clone()
            .or_else(|| self.masters.get(self.active).map(|m| self.master_location(m)))
            .unwrap_or_else(|| vec![0.0; self.axes.len()]);
        self.axes.iter().map(|a| a.tag.clone()).zip(loc).collect()
    }

    /// The master at the default location, if there is one.
    pub fn default_master(&self) -> Option<usize> {
        self.masters.iter().position(|m| self.master_location(m).iter().all(|v| v.abs() < 1e-9))
    }
}

/// One master's drawings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MasterLayer {
    #[serde(default)]
    pub bases: BTreeMap<BaseId, BaseLayer>,
    #[serde(default)]
    pub alterations: BTreeMap<String, Vec<Contour>>,
    #[serde(default)]
    pub symbols: BTreeMap<String, SymbolLayer>,
    #[serde(default)]
    pub components: BTreeMap<String, Vec<Contour>>,
    /// Each parametric part's states, in order.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub part_states: BTreeMap<String, Vec<Vec<Contour>>>,
    #[serde(default)]
    pub families: BTreeMap<FamilyId, FamilyLayer>,
    #[serde(default)]
    pub kern_pairs: Vec<crate::kerning::KernPair>,
    #[serde(default)]
    pub backgrounds: BTreeMap<String, Vec<Contour>>,
    #[serde(default)]
    pub italic_angle: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BaseLayer {
    pub advance_width: f64,
    #[serde(default)]
    pub contours: Vec<Contour>,
    #[serde(default)]
    pub anchors: BTreeMap<String, Vec2>,
    #[serde(default)]
    pub components: Vec<ComponentRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SymbolLayer {
    pub advance_width: f64,
    #[serde(default)]
    pub contours: Vec<Contour>,
    #[serde(default)]
    pub components: Vec<ComponentRef>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub anchors: BTreeMap<String, Vec2>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FamilyLayer {
    #[serde(default)]
    pub attach_offsets: BTreeMap<String, Vec2>,
    #[serde(default)]
    pub states: BTreeMap<Order, FidelState>,
    /// Components placed on single fidels.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub components: BTreeMap<Order, Vec<ComponentRef>>,
}

impl MasterLayer {
    /// The drawings in a project now.
    pub fn take(p: &Project) -> Self {
        MasterLayer {
            bases: p
                .bases
                .iter()
                .map(|(id, b)| {
                    let l = BaseLayer {
                        advance_width: b.advance_width,
                        contours: b.contours.clone(),
                        anchors: b.anchors.clone(),
                        components: b.components.clone(),
                    };
                    (id.clone(), l)
                })
                .collect(),
            alterations: p.alterations.iter().map(|(id, a)| (id.clone(), a.contours.clone())).collect(),
            symbols: p
                .symbols
                .iter()
                .map(|(id, s)| {
                    let l = SymbolLayer {
                        advance_width: s.advance_width,
                        contours: s.contours.clone(),
                        components: s.components.clone(),
                        anchors: s.anchors.clone(),
                    };
                    (id.clone(), l)
                })
                .collect(),
            components: p.components.iter().map(|(id, c)| (id.clone(), c.contours.clone())).collect(),
            part_states: p
                .components
                .iter()
                .filter(|(_, c)| !c.states.is_empty())
                .map(|(id, c)| (id.clone(), c.states.iter().map(|s| s.contours.clone()).collect()))
                .collect(),
            families: p
                .families
                .iter()
                .map(|(id, f)| {
                    let l = FamilyLayer {
                        attach_offsets: f.attach_offsets.clone(),
                        states: f.fidels.iter().map(|(o, fi)| (*o, fi.state.clone())).collect(),
                        components: f
                            .fidels
                            .iter()
                            .filter(|(_, fi)| !fi.components.is_empty())
                            .map(|(o, fi)| (*o, fi.components.clone()))
                            .collect(),
                    };
                    (id.clone(), l)
                })
                .collect(),
            kern_pairs: p.kerning.pairs.clone(),
            backgrounds: p.backgrounds.clone(),
            italic_angle: p.metrics.italic_angle,
        }
    }

    /// Put these drawings into a project. Drawings the layer does not have
    /// (added after it was made) keep what the project has.
    pub fn apply(&self, p: &mut Project) {
        for (id, l) in &self.bases {
            if let Some(b) = p.bases.get_mut(id) {
                b.advance_width = l.advance_width;
                b.contours = l.contours.clone();
                b.anchors = l.anchors.clone();
                b.components = l.components.clone();
            }
        }
        for (id, c) in &self.alterations {
            if let Some(a) = p.alterations.get_mut(id) {
                a.contours = c.clone();
            }
        }
        for (id, l) in &self.symbols {
            if let Some(s) = p.symbols.get_mut(id) {
                s.advance_width = l.advance_width;
                s.contours = l.contours.clone();
                s.components = l.components.clone();
                s.anchors = l.anchors.clone();
            }
        }
        for (id, c) in &self.components {
            if let Some(comp) = p.components.get_mut(id) {
                comp.contours = c.clone();
            }
        }
        for (id, states) in &self.part_states {
            if let Some(comp) = p.components.get_mut(id) {
                for (s, c) in comp.states.iter_mut().zip(states) {
                    s.contours = c.clone();
                }
            }
        }
        for (id, l) in &self.families {
            if let Some(f) = p.families.get_mut(id) {
                f.attach_offsets = l.attach_offsets.clone();
                for (o, s) in &l.states {
                    if let Some(fi) = f.fidels.get_mut(o) {
                        fi.state = s.clone();
                        fi.components = l.components.get(o).cloned().unwrap_or_default();
                    }
                }
            }
        }
        // Pairs of classes that no longer exist are dropped.
        p.kerning.pairs = self
            .kern_pairs
            .iter()
            .filter(|k| {
                let ok = |s: &str, side| match s.strip_prefix('@') {
                    Some(n) => p.kerning.classes(side).contains_key(n),
                    None => true,
                };
                ok(&k.left, crate::kerning::KernSide::Left) && ok(&k.right, crate::kerning::KernSide::Right)
            })
            .cloned()
            .collect();
        p.backgrounds = self.backgrounds.clone();
        p.metrics.italic_angle = self.italic_angle;
    }
}

// ---------- The variation model ----------

/// Per axis: lower, peak, upper.
pub type Region = Vec<(f64, f64, f64)>;

/// How much a region counts at a location.
pub fn support_scalar(loc: &[f64], region: &Region, ranges: Option<&[(f64, f64)]>) -> f64 {
    let mut scalar = 1.0;
    for (i, &(lower, peak, upper)) in region.iter().enumerate() {
        if peak == 0.0 {
            continue;
        }
        let v = loc.get(i).copied().unwrap_or(0.0);
        if v == peak {
            continue;
        }
        if let Some(ranges) = ranges {
            let (amin, amax) = ranges[i];
            if v < amin && lower <= amin {
                if peak <= amin && peak < upper {
                    scalar *= (v - upper) / (peak - upper);
                    continue;
                } else if amin < peak {
                    scalar *= (v - lower) / (peak - lower);
                    continue;
                }
            } else if amax < v && amax <= upper {
                if amax <= peak && lower < peak {
                    scalar *= (v - lower) / (peak - lower);
                    continue;
                } else if peak < amax {
                    scalar *= (v - upper) / (peak - upper);
                    continue;
                }
            }
        }
        if v <= lower || upper <= v {
            return 0.0;
        }
        scalar *= if v < peak { (v - lower) / (peak - lower) } else { (v - upper) / (peak - upper) };
    }
    scalar
}

/// The OpenType variation model for a set of master locations (normalized).
#[derive(Debug, Clone)]
pub struct Model {
    /// Master indices, in the order the deltas build on each other.
    pub order: Vec<usize>,
    /// The region of each master, in `order`.
    pub supports: Vec<Region>,
    /// For each master in `order`, the earlier masters it subtracts.
    weights: Vec<Vec<(usize, f64)>>,
    /// Smallest and largest master value per axis, for extrapolation.
    ranges: Vec<(f64, f64)>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ModelError {
    #[error("No master sits at the default location")]
    NoDefault,
    #[error("Two masters share a location")]
    Duplicate,
}

impl Model {
    pub fn new(locations: &[Vec<f64>]) -> Result<Self, ModelError> {
        let axes = locations.first().map_or(0, Vec::len);
        let near = |a: &[f64], b: &[f64]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9);
        for (i, a) in locations.iter().enumerate() {
            if locations[..i].iter().any(|b| near(a, b)) {
                return Err(ModelError::Duplicate);
            }
        }
        if !locations.iter().any(|l| l.iter().all(|v| v.abs() < 1e-9)) {
            return Err(ModelError::NoDefault);
        }
        let mut order: Vec<usize> = (0..locations.len()).collect();
        // The default first, then masters on one axis, then corners; within
        // that, by axis, negative before positive, nearest first.
        let key = |i: &usize| {
            let l = &locations[*i];
            let n = l.iter().filter(|v| v.abs() > 1e-9).count();
            let per: Vec<(i8, i64)> = l
                .iter()
                .map(|v| {
                    let s = if v.abs() < 1e-9 {
                        0
                    } else if *v < 0.0 {
                        -1
                    } else {
                        1
                    };
                    (if s == 0 { 2 } else { s }, (v.abs() * 1e6) as i64)
                })
                .collect();
            (n, per)
        };
        order.sort_by_key(key);
        let regions: Vec<Region> = order
            .iter()
            .map(|&i| locations[i].iter().map(|&v| (v.min(0.0), v, v.max(0.0))).collect())
            .collect();
        let mut supports: Vec<Region> = Vec::new();
        for (i, region) in regions.iter().enumerate() {
            let mut region = region.clone();
            let axes_of = |r: &Region| r.iter().map(|t| t.1 != 0.0).collect::<Vec<_>>();
            let loc_axes = axes_of(&region);
            for prev in &regions[..i] {
                if axes_of(prev) != loc_axes {
                    continue;
                }
                let relevant = region.iter().zip(prev).all(|(&(lower, peak, upper), p)| {
                    peak == 0.0 || p.1 == peak || (lower < p.1 && p.1 < upper)
                });
                if !relevant {
                    continue;
                }
                let mut best: Vec<(usize, (f64, f64, f64))> = Vec::new();
                let mut best_ratio = -1.0;
                for ax in 0..axes {
                    let val = prev[ax].1;
                    if val == 0.0 && region[ax].1 == 0.0 {
                        continue;
                    }
                    let (lower, loc_v, upper) = region[ax];
                    let (mut new_lower, mut new_upper) = (lower, upper);
                    let ratio;
                    if val < loc_v {
                        new_lower = val;
                        ratio = (val - loc_v) / (lower - loc_v);
                    } else if loc_v < val {
                        new_upper = val;
                        ratio = (val - loc_v) / (upper - loc_v);
                    } else {
                        continue;
                    }
                    if ratio > best_ratio {
                        best.clear();
                        best_ratio = ratio;
                    }
                    if ratio == best_ratio {
                        best.push((ax, (new_lower, loc_v, new_upper)));
                    }
                }
                for (ax, t) in best {
                    region[ax] = t;
                }
            }
            supports.push(region);
        }
        let sorted: Vec<&Vec<f64>> = order.iter().map(|&i| &locations[i]).collect();
        let weights = (0..sorted.len())
            .map(|i| {
                (0..i)
                    .filter_map(|j| {
                        let w = support_scalar(sorted[i], &supports[j], None);
                        (w != 0.0).then_some((j, w))
                    })
                    .collect()
            })
            .collect();
        let ranges = (0..axes)
            .map(|a| {
                let vs = locations.iter().map(|l| l[a]);
                (vs.clone().fold(0.0, f64::min), vs.fold(0.0, f64::max))
            })
            .collect();
        Ok(Model { order, supports, weights, ranges })
    }

    /// Deltas, in `order`, from one value list per master (in master order).
    pub fn deltas(&self, values: &[Vec<f64>]) -> Vec<Vec<f64>> {
        let mut out: Vec<Vec<f64>> = Vec::with_capacity(self.order.len());
        for (i, &m) in self.order.iter().enumerate() {
            let mut d = values[m].clone();
            for &(j, w) in &self.weights[i] {
                for (x, y) in d.iter_mut().zip(&out[j]) {
                    *x -= w * y;
                }
            }
            out.push(d);
        }
        out
    }

    /// The values at a location, extrapolating past the outermost masters.
    pub fn interpolate(&self, values: &[Vec<f64>], loc: &[f64]) -> Vec<f64> {
        let deltas = self.deltas(values);
        let mut out = vec![0.0; values.first().map_or(0, Vec::len)];
        for (d, s) in deltas.iter().zip(&self.supports) {
            let w = support_scalar(loc, s, Some(&self.ranges));
            if w != 0.0 {
                for (o, x) in out.iter_mut().zip(d) {
                    *o += w * x;
                }
            }
        }
        out
    }
}

// ---------- Interpolating layers ----------

/// Editor states that may differ between masters without breaking anything.
const LOOSE: [&str; 4] = ["smooth", "locked", "hidden", "name"];

/// Same shape and the same text everywhere: only numbers may differ.
fn same_shape(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => true,
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same_shape(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            let keys = |o: &serde_json::Map<String, Value>| {
                o.keys().filter(|k| !LOOSE.contains(&k.as_str())).count()
            };
            keys(x) == keys(y)
                && x.iter()
                    .filter(|(k, _)| !LOOSE.contains(&k.as_str()))
                    .all(|(k, v)| y.get(k).is_some_and(|w| same_shape(v, w)))
        }
        _ => a == b,
    }
}

fn numbers(v: &Value, out: &mut Vec<f64>) {
    match v {
        Value::Number(n) => out.push(n.as_f64().unwrap_or(0.0)),
        Value::Array(a) => a.iter().for_each(|x| numbers(x, out)),
        Value::Object(o) => o.values().for_each(|x| numbers(x, out)),
        _ => {}
    }
}

fn put_numbers(v: &mut Value, vals: &[f64], at: &mut usize, all_same: &[bool]) {
    match v {
        Value::Number(n) => {
            if !all_same[*at] {
                if let Some(x) = serde_json::Number::from_f64((vals[*at] * 1000.0).round() / 1000.0) {
                    *n = x;
                }
            }
            *at += 1;
        }
        Value::Array(a) => a.iter_mut().for_each(|x| put_numbers(x, vals, at, all_same)),
        Value::Object(o) => o.values_mut().for_each(|x| put_numbers(x, vals, at, all_same)),
        _ => {}
    }
}

/// A drawing that cannot interpolate: its outline differs in structure
/// between masters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Incompatible {
    /// `base:ha`, `alteration:…`, `symbol:…`, `component:…`, `fidel:ha/kaib`.
    pub drawing: String,
    /// Master names it differs in from the default.
    pub masters: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DesignError {
    #[error("No master “{0}”")]
    NoMaster(String),
    #[error("The last master cannot be removed")]
    LastMaster,
    #[error("An axis tag is four letters")]
    BadTag,
    #[error("There is already an axis “{0}”")]
    TagTaken(String),
    #[error("{0}")]
    Model(#[from] ModelError),
}

impl Project {
    /// The masters, with the project's single implicit master when none
    /// were made.
    pub fn master_count(&self) -> usize {
        self.design.masters.len().max(1)
    }

    /// Every master's layer, in master order, the active one from the project.
    pub fn master_layers(&self) -> Vec<MasterLayer> {
        let now = MasterLayer::take(self);
        if self.design.masters.is_empty() {
            return vec![now];
        }
        self.design
            .masters
            .iter()
            .enumerate()
            .map(|(i, m)| {
                if i == self.design.active {
                    now.clone()
                } else {
                    m.layer.clone().unwrap_or_else(|| now.clone())
                }
            })
            .collect()
    }

    /// Make another master active: its drawings move into the project.
    pub fn switch_master(&mut self, index: usize) -> Result<(), DesignError> {
        if index >= self.design.masters.len() {
            return Err(DesignError::NoMaster(index.to_string()));
        }
        if index == self.design.active {
            return Ok(());
        }
        let now = MasterLayer::take(self);
        let next = self.design.masters[index].layer.take().unwrap_or_else(|| now.clone());
        let active = self.design.active;
        self.design.masters[active].layer = Some(now);
        next.apply(self);
        self.design.active = index;
        self.after_edit();
        Ok(())
    }

    /// A copy of the project with one master active.
    pub fn master_project(&self, index: usize) -> Project {
        let mut p = self.clone();
        if index < p.design.masters.len() {
            let _ = p.switch_master(index);
        }
        p
    }

    /// Add a master, starting from the active master's drawings. The first
    /// call also names the project's own drawings as the first master.
    pub fn add_master(&mut self, name: &str, location: BTreeMap<String, f64>) -> usize {
        if self.design.masters.is_empty() {
            let loc = self.design.axes.iter().map(|a| (a.tag.clone(), a.to_design(a.default))).collect();
            let first = self.info.style_name.trim();
            let first = if first.is_empty() { "Regular" } else { first };
            self.design.masters.push(Master {
                id: "m1".into(),
                name: first.into(),
                location: loc,
                layer: None,
            });
            self.design.active = 0;
        }
        let mut n = self.design.masters.len() + 1;
        while self.design.masters.iter().any(|m| m.id == format!("m{n}")) {
            n += 1;
        }
        self.design.masters.push(Master {
            id: format!("m{n}"),
            name: name.to_string(),
            location,
            layer: Some(MasterLayer::take(self)),
        });
        self.design.masters.len() - 1
    }

    /// Slant the drawings of the master being edited by `degrees` (positive
    /// leans right), shearing about the baseline, and add it to the master's
    /// italic angle. A starting point for an italic, to refine by hand.
    pub fn slant_master(&mut self, degrees: f64) {
        let t = degrees.to_radians().tan();
        let pt = |v: &mut Vec2| v.x += v.y * t;
        let shear = |cs: &mut Vec<Contour>| {
            for c in cs {
                for p in &mut c.points {
                    p.pos.x += p.pos.y * t;
                }
            }
        };
        for b in self.bases.values_mut() {
            shear(&mut b.contours);
            b.anchors.values_mut().for_each(pt);
            b.components.iter_mut().for_each(|r| pt(&mut r.at));
        }
        self.alterations.values_mut().for_each(|a| shear(&mut a.contours));
        for s in self.symbols.values_mut() {
            shear(&mut s.contours);
            s.components.iter_mut().for_each(|r| pt(&mut r.at));
            s.anchors.values_mut().for_each(pt);
        }
        for c in self.components.values_mut() {
            shear(&mut c.contours);
            c.states.iter_mut().for_each(|s| shear(&mut s.contours));
        }
        for f in self.families.values_mut() {
            f.attach_offsets.values_mut().for_each(pt);
            for fi in f.fidels.values_mut() {
                match &mut fi.state {
                    FidelState::Detached { contours } => shear(contours),
                    FidelState::Adjusted { nudges } => nudges.iter_mut().for_each(|n| pt(&mut n.delta)),
                    FidelState::Linked => {}
                }
            }
        }
        self.backgrounds.values_mut().for_each(shear);
        self.metrics.italic_angle += degrees;
        self.after_edit();
    }

    /// Rename or move a master.
    pub fn set_master(
        &mut self,
        index: usize,
        name: &str,
        location: BTreeMap<String, f64>,
    ) -> Result<(), DesignError> {
        let m = self.design.masters.get_mut(index).ok_or_else(|| DesignError::NoMaster(index.to_string()))?;
        if !name.trim().is_empty() {
            m.name = name.trim().to_string();
        }
        m.location = location;
        Ok(())
    }

    /// The project as exported as one static font: the default master's
    /// drawings, or the active ones when no master sits at the default.
    pub fn default_project(&self) -> Project {
        match self.design.default_master() {
            Some(d) if d != self.design.active => self.master_project(d),
            _ => self.clone(),
        }
    }

    pub fn remove_master(&mut self, index: usize) -> Result<(), DesignError> {
        let ms = &self.design.masters;
        if index >= ms.len() {
            return Err(DesignError::NoMaster(index.to_string()));
        }
        if ms.len() <= 1 {
            return Err(DesignError::LastMaster);
        }
        if index == self.design.active {
            self.switch_master(if index == 0 { 1 } else { 0 })?;
        }
        self.design.masters.remove(index);
        if self.design.active > index {
            self.design.active -= 1;
        }
        if self.design.masters.len() == 1 {
            // Back to one master: its drawings are the project's.
            self.design.masters.clear();
            self.design.active = 0;
        }
        Ok(())
    }

    /// Add or change an axis. Masters without a value sit at its default.
    pub fn set_axis(&mut self, old_tag: Option<&str>, axis: Axis) -> Result<(), DesignError> {
        if axis.tag.chars().count() != 4 || !axis.tag.is_ascii() {
            return Err(DesignError::BadTag);
        }
        let taken = self.design.axes.iter().any(|a| a.tag == axis.tag && Some(a.tag.as_str()) != old_tag);
        if taken {
            return Err(DesignError::TagTaken(axis.tag));
        }
        let mut axis = axis;
        let (lo, hi) = (axis.min.min(axis.max), axis.min.max(axis.max));
        axis.min = lo;
        axis.max = hi;
        axis.default = axis.default.clamp(lo, hi);
        axis.map.sort_by(|a, b| a[0].total_cmp(&b[0]));
        match old_tag.and_then(|t| self.design.axes.iter().position(|a| a.tag == t)) {
            Some(i) => {
                let old = self.design.axes[i].tag.clone();
                if old != axis.tag {
                    for m in &mut self.design.masters {
                        if let Some(v) = m.location.remove(&old) {
                            m.location.insert(axis.tag.clone(), v);
                        }
                    }
                    for inst in &mut self.design.instances {
                        if let Some(v) = inst.location.remove(&old) {
                            inst.location.insert(axis.tag.clone(), v);
                        }
                    }
                }
                self.design.axes[i] = axis;
            }
            None => self.design.axes.push(axis),
        }
        Ok(())
    }

    pub fn remove_axis(&mut self, tag: &str) {
        self.design.axes.retain(|a| a.tag != tag);
        for m in &mut self.design.masters {
            m.location.remove(tag);
        }
        for i in &mut self.design.instances {
            i.location.remove(tag);
        }
    }

    /// The model over all masters, and each master's normalized location.
    pub fn model(&self) -> Result<(Model, Vec<Vec<f64>>), DesignError> {
        if self.design.masters.is_empty() {
            let locs = vec![vec![0.0; self.design.axes.len()]];
            return Ok((Model::new(&locs)?, locs));
        }
        let locs: Vec<Vec<f64>> =
            self.design.masters.iter().map(|m| self.design.master_location(m)).collect();
        Ok((Model::new(&locs)?, locs))
    }

    /// The project at a location in user units: every master's drawings
    /// interpolated, the default master's wherever they do not match.
    pub fn instance_at(&self, user: &BTreeMap<String, f64>) -> Result<Project, DesignError> {
        self.instance_at_loc(self.design.user_location(user), true)
    }

    /// The project at a normalized location; brace layers count when
    /// `braces` is set.
    pub fn instance_at_loc(&self, loc: Vec<f64>, braces: bool) -> Result<Project, DesignError> {
        if self.design.masters.len() < 2 {
            let mut p = self.clone();
            p.design.at = Some(loc);
            return Ok(p);
        }
        let (model, _) = self.model()?;
        let layers = self.master_layers();
        let def = self.design.default_master().ok_or(ModelError::NoDefault)?;
        let trees: Vec<Value> =
            layers.iter().map(|l| serde_json::to_value(l).unwrap_or(Value::Null)).collect();
        // The default leads: its subtree is kept where the masters disagree.
        let mut refs: Vec<&Value> = vec![&trees[def]];
        refs.extend(trees.iter());
        let blended = blend(&refs, &model, &loc);
        let layer: MasterLayer = serde_json::from_value(blended).unwrap_or_else(|_| layers[def].clone());
        let mut p = self.clone();
        layer.apply(&mut p);
        if braces {
            self.blend_braces(&mut p, &layers, &loc);
        }
        p.design.at = Some(loc);
        p.after_edit();
        Ok(p)
    }

    /// Drawings whose outlines differ in structure between masters, so they
    /// cannot interpolate.
    pub fn compatibility(&self) -> Vec<Incompatible> {
        if self.design.masters.len() < 2 {
            return Vec::new();
        }
        let layers = self.master_layers();
        let def = self.design.default_master().unwrap_or(0);
        let tree: Vec<Value> =
            layers.iter().map(|l| serde_json::to_value(l).unwrap_or(Value::Null)).collect();
        let mut out: Vec<Incompatible> = Vec::new();
        let mut note = |drawing: String, m: usize| {
            let name = self.design.masters[m].name.clone();
            match out.iter_mut().find(|x| x.drawing == drawing) {
                Some(x) => x.masters.push(name),
                None => out.push(Incompatible { drawing, masters: vec![name] }),
            }
        };
        let get = |t: &Value, path: &[&str]| -> Option<Value> {
            let mut v = t;
            for k in path {
                v = v.get(*k)?;
            }
            Some(v.clone())
        };
        for (m, t) in tree.iter().enumerate() {
            if m == def {
                continue;
            }
            let d = &tree[def];
            let mut check = |kind: &str, id: &str, path: Vec<&str>| {
                if let (Some(a), Some(b)) = (get(d, &path), get(t, &path)) {
                    if !same_shape(&a, &b) {
                        note(format!("{kind}:{id}"), m);
                    }
                }
            };
            for id in self.bases.keys() {
                check("base", id, vec!["bases", id, "contours"]);
            }
            for id in self.alterations.keys() {
                check("alteration", id, vec!["alterations", id]);
            }
            for id in self.symbols.keys() {
                check("symbol", id, vec!["symbols", id, "contours"]);
            }
            for id in self.components.keys() {
                check("component", id, vec!["components", id]);
            }
            for (fid, f) in &self.families {
                for o in f.fidels.keys() {
                    let key = serde_json::to_value(o)
                        .ok()
                        .and_then(|v| v.as_str().map(String::from))
                        .unwrap_or_default();
                    check("fidel", &format!("{fid}/{key}"), vec!["families", fid, "states", &key]);
                }
            }
        }
        out
    }
}

/// `trees[0]` is the fallback; `trees[1..]` are the masters in master order.
fn blend(trees: &[&Value], model: &Model, loc: &[f64]) -> Value {
    let first = trees[0];
    let masters = &trees[1..];
    match first {
        Value::Object(o) if masters.iter().all(|t| t.is_object()) => {
            let mut out = serde_json::Map::new();
            for (k, v) in o {
                let kids: Option<Vec<&Value>> = trees.iter().map(|t| t.get(k)).collect();
                out.insert(
                    k.clone(),
                    match kids {
                        Some(kids) => blend(&kids, model, loc),
                        None => v.clone(),
                    },
                );
            }
            Value::Object(out)
        }
        Value::Array(_) | Value::Number(_) => {
            if !masters.iter().all(|t| same_shape(first, t)) {
                return first.clone();
            }
            let vals: Vec<Vec<f64>> = masters
                .iter()
                .map(|t| {
                    let mut v = Vec::new();
                    numbers(t, &mut v);
                    v
                })
                .collect();
            let all_same: Vec<bool> =
                (0..vals[0].len()).map(|i| vals.iter().all(|v| v[i] == vals[0][i])).collect();
            let out = model.interpolate(&vals, loc);
            let mut res = first.clone();
            put_numbers(&mut res, &out, &mut 0, &all_same);
            res
        }
        _ => first.clone(),
    }
}
