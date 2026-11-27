//! The project: everything a .kid file will hold for one master.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::alteration::{Alteration, AlterationId};
use crate::base::{Base, BaseId};
use crate::charset::{CharSet, Language};
use crate::component::{Component, ComponentId};
use crate::fidel::{merge_nudge, Family, FamilyId, Fidel, FidelState, NudgeTarget, Source, StateKind};
use crate::geometry::{Contour, ContourProblem, Vec2};
use crate::order::{Order, OrderRule};
use crate::resolve::{self, ResolvedFidel};

/// Vertical metrics. Ethiopic letters align on the Pa-height lines rather than
/// standing on the baseline (Hornus p. 53).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Metrics {
    pub units_per_em: u16,
    pub pa_top: f64,
    pub pa_bottom: f64,
    /// Pa-height zones the designer moved or added. Built-in zones not listed
    /// here sit at their default height; see [`Metrics::zones`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub zones: Vec<Zone>,
    /// Degrees clockwise from upright, positive for a right-leaning italic.
    /// Each master has its own.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub italic_angle: f64,
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics { units_per_em: 1000, pa_top: 700.0, pa_bottom: 0.0, zones: Vec::new(), italic_angle: 0.0 }
    }
}

/// A height inside the Pa band where a kind of alteration lands: shortened
/// legs end on the same line, cricks bend at the same height, and so on
/// ("to similar alteration, similar positioning"). Stored as a fraction of
/// the Pa-height so zones follow when the Pa lines move.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    /// 0 is Pa-bottom, 1 is Pa-top.
    pub at: f64,
    /// Snapping band around the zone, as a fraction of the Pa-height.
    #[serde(default = "default_zone_size")]
    pub size: f64,
}

fn default_zone_size() -> f64 {
    0.04
}

pub const ZONE_SHORT_LEG: &str = "short-leg";
pub const ZONE_CRICK: &str = "crick";
pub const ZONE_STRETCH: &str = "stretch";

/// The built-in zones.
pub fn default_zones() -> Vec<Zone> {
    let z = |id: &str, name: &str, at: f64| Zone {
        id: id.into(),
        name: name.into(),
        at,
        size: default_zone_size(),
    };
    vec![z(ZONE_SHORT_LEG, "Short leg", 0.4), z(ZONE_STRETCH, "Stretch", 0.45), z(ZONE_CRICK, "Crick", 0.3)]
}

impl Metrics {
    pub fn pa_height(&self) -> f64 {
        self.pa_top - self.pa_bottom
    }

    /// Every zone: the built-in ones (moved where the designer moved them)
    /// and any the designer added.
    pub fn zones(&self) -> Vec<Zone> {
        let mut out = default_zones();
        for z in &self.zones {
            match out.iter_mut().find(|d| d.id == z.id) {
                Some(d) => *d = z.clone(),
                None => out.push(z.clone()),
            }
        }
        out
    }

    pub fn zone(&self, id: &str) -> Option<Zone> {
        self.zones().into_iter().find(|z| z.id == id)
    }

    /// Height of a zone in font units.
    pub fn zone_y(&self, id: &str) -> Option<f64> {
        self.zone(id).map(|z| self.pa_bottom + z.at * self.pa_height())
    }

    /// Move a zone (or add one), given its height in font units.
    pub fn set_zone(&mut self, id: &str, name: Option<&str>, y: f64) {
        let h = self.pa_height().max(1.0);
        let mut z = self.zone(id).unwrap_or(Zone {
            id: id.into(),
            name: name.unwrap_or(id).into(),
            at: 0.0,
            size: default_zone_size(),
        });
        if let Some(n) = name {
            z.name = n.into();
        }
        z.at = (y - self.pa_bottom) / h;
        match self.zones.iter_mut().find(|s| s.id == id) {
            Some(s) => *s = z,
            None => self.zones.push(z),
        }
    }
}

/// Names written into the exported font.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FontInfo {
    /// Empty means "use the project's file name".
    pub family_name: String,
    pub style_name: String,
    pub version: f64,
    pub designer: String,
    /// Width of the word space, in font units. `None` uses a third of the em
    /// less a little (0.3 em), close to the reference Ethiopic fonts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_width: Option<f64>,
}

impl FontInfo {
    /// The space's advance for this em size.
    pub fn space_advance(&self, units_per_em: u16) -> f64 {
        self.space_width.filter(|w| *w >= 0.0).unwrap_or(f64::from(units_per_em) * 0.3)
    }
}

impl Default for FontInfo {
    fn default() -> Self {
        FontInfo {
            family_name: String::new(),
            style_name: "Regular".into(),
            version: 1.0,
            designer: String::new(),
            space_width: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Project {
    #[serde(default)]
    pub info: FontInfo,
    pub metrics: Metrics,
    pub bases: BTreeMap<BaseId, Base>,
    pub alterations: BTreeMap<AlterationId, Alteration>,
    pub order_rules: BTreeMap<Order, OrderRule>,
    pub families: BTreeMap<FamilyId, Family>,
    /// The parts of the Ethiopic repertoire this project covers. Fidel and
    /// symbols outside these sets are kept but hidden and not exported.
    /// Empty means Ge'ez only.
    #[serde(default)]
    pub charsets: BTreeSet<CharSet>,
    /// Language presets the project covers, on top of `charsets`.
    #[serde(default)]
    pub languages: BTreeSet<Language>,
    /// Standalone glyphs: punctuation, numerals, combining marks.
    #[serde(default)]
    pub symbols: BTreeMap<SymbolId, Symbol>,
    /// Other drawings of characters, for features to swap in.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub alternates: BTreeMap<String, crate::alternates::Alternate>,
    /// Leaves, caps and corners, drawn once and placed on bases.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub components: BTreeMap<ComponentId, Component>,
    /// Guides drawn in the editor, global and per drawing.
    #[serde(default, skip_serializing_if = "crate::guides::Guides::is_empty")]
    pub guides: crate::guides::Guides,
    /// Background (mask) layers: outlines kept behind a drawing to compare
    /// against, keyed like local guides (`base:la`). Not exported.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub backgrounds: BTreeMap<String, Vec<Contour>>,
    /// Colour marks, tags, notes and saved filters. Not exported.
    #[serde(default, skip_serializing_if = "crate::organize::Organize::is_empty")]
    pub organize: crate::organize::Organize,
    /// Kerning pairs and classes.
    #[serde(default, skip_serializing_if = "crate::kerning::Kerning::is_empty")]
    pub kerning: crate::kerning::Kerning,
    /// Axes, masters and instances.
    #[serde(default, skip_serializing_if = "crate::designspace::Designspace::is_empty")]
    pub design: crate::designspace::Designspace,
    /// OpenType feature code, glyph classes and language systems.
    #[serde(default, skip_serializing_if = "crate::features::Features::is_default")]
    pub features: crate::features::Features,
    /// Automatic spacing and kerning settings, and the corpus counts.
    #[serde(default, skip_serializing_if = "crate::spacing::Spacing::is_default")]
    pub spacing: crate::spacing::Spacing,
}

pub type SymbolId = String;

/// A glyph outside the fidel system: ፡ ። ፩ ፲ and the like. Drawn directly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Symbol {
    /// `uni1361`.
    pub id: SymbolId,
    pub codepoint: char,
    pub name: String,
    pub advance_width: f64,
    #[serde(default)]
    pub contours: Vec<Contour>,
    /// Components placed on it: a numeral frame, a shared dot.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<crate::component::ComponentRef>,
    /// Sidebearings and width set by other glyphs, or fixed (`=600` for
    /// tabular numerals).
    #[serde(default, skip_serializing_if = "crate::metric_keys::MetricKeys::is_empty")]
    pub metric_keys: crate::metric_keys::MetricKeys,
    /// Named points marks attach to: `top` on a letter, `_top` on an accent.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub anchors: BTreeMap<String, Vec2>,
    /// Built from other glyphs instead of drawn: a base letter, then the
    /// accents placed on it by their anchors (À is A and ◌̀).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub built_from: Vec<char>,
}

#[derive(Debug, Error, PartialEq)]
pub enum ModelError {
    #[error("no alternate `{0}`")]
    UnknownAlternate(String),
    #[error(
        "“{0}” is not a feature suffix: use a tag such as ss01, salt or cv01, or locl.TIR for a language"
    )]
    BadSuffix(String),
    #[error("{0} already exists")]
    AlternateTaken(String),
    #[error("{0} has no glyph to start from")]
    NoGlyph(char),
    #[error("{0} already belongs to another glyph")]
    CodepointTaken(char),
    #[error("no brace layer `{0}`")]
    UnknownBrace(String),
    #[error("Only bases and symbols take brace layers")]
    NoBrace,
    #[error("only bases and symbols have metrics of their own")]
    NoMetrics,
    #[error("Draw and space {0} first: the other glyphs are spaced to match it")]
    NotSpaced(char),
    #[error("no family `{0}`")]
    UnknownFamily(FamilyId),
    #[error("family `{0}` has no {1:?} fidel")]
    UnknownFidel(FamilyId, Order),
    #[error("a {0:?} fidel has no generated outline to nudge; edit its contours directly")]
    NotGenerated(StateKind),
    #[error("no base `{0}`")]
    UnknownBase(BaseId),
    #[error("{0}/{1:?} is generated; detach it to edit its outline")]
    NotDrawnByHand(FamilyId, Order),
    #[error("`{0}` is not a fidel reference (family/order)")]
    BadFidelRef(String),
    #[error("no symbol `{0}`")]
    UnknownSymbol(SymbolId),
    #[error("no alteration `{0}`")]
    UnknownAlteration(AlterationId),
    #[error("no fidel in that scope uses `{0}`")]
    NotUsedInScope(AlterationId),
    #[error("`{0}` is the shared alteration, not a copy")]
    NotAFork(AlterationId),
    #[error("{0:?} is already built on this fidel, directly or through another order")]
    BuiltOnCycle(Order),
    #[error("contour {contour}: {problem:?}")]
    InvalidContour { contour: u32, problem: ContourProblem },
    #[error("two contours share the id {0}")]
    DuplicateContourId(u32),
    #[error("no component `{0}`")]
    UnknownComponent(ComponentId),
    #[error("the {0:?} rule has no variant {1}")]
    NoSuchVariant(Order, usize),
    #[error("two component placements share the id {0}")]
    DuplicatePlacementId(u32),
}

/// A drawing the glyph editor can open: a base, an alteration, a symbol, or
/// a fidel drawn by hand, as `family/order`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "kind", content = "id")]
pub enum DrawingTarget {
    Base(BaseId),
    Alteration(AlterationId),
    Symbol(SymbolId),
    Fidel(String),
    Component(ComponentId),
    /// An intermediate drawing of a base or symbol at one location.
    Brace(String),
    /// Another drawing of a character, for a feature to swap in.
    Alternate(String),
}

impl DrawingTarget {
    pub fn fidel(family: &str, order: Order) -> Self {
        DrawingTarget::Fidel(format!("{family}/{}", serde_plain_order(order)))
    }

    /// The family and order of a `Fidel` target.
    pub fn fidel_ref(id: &str) -> Result<(FamilyId, Order), ModelError> {
        let bad = || ModelError::BadFidelRef(id.into());
        let (family, order) = id.rsplit_once('/').ok_or_else(bad)?;
        let order: Order =
            serde_json::from_value(serde_json::Value::String(order.into())).map_err(|_| bad())?;
        Ok((family.into(), order))
    }
}

fn serde_plain_order(order: Order) -> String {
    serde_json::to_value(order).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

/// Something upstream that is about to change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "kind", content = "id")]
pub enum Change {
    Base(BaseId),
    Alteration(AlterationId),
}

/// What a change will do to one fidel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Effect {
    /// Regenerated from scratch.
    Regenerates,
    /// Regenerated, then its nudges are re-applied.
    RegeneratesKeepingNudges,
    /// Uses the changed thing but will not update (drawn by hand).
    Untouched,
}

/// One row of the "what will change" preview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Impact {
    pub family: FamilyId,
    pub order: Order,
    pub state: StateKind,
    pub effect: Effect,
}

impl Project {
    /// The contours of a base or an alteration.
    pub fn drawing(&self, target: &DrawingTarget) -> Result<&[Contour], ModelError> {
        match target {
            DrawingTarget::Base(id) => self
                .bases
                .get(id)
                .map(|b| b.contours.as_slice())
                .ok_or_else(|| ModelError::UnknownBase(id.clone())),
            DrawingTarget::Alteration(id) => self
                .alterations
                .get(id)
                .map(|a| a.contours.as_slice())
                .ok_or_else(|| ModelError::UnknownAlteration(id.clone())),
            DrawingTarget::Symbol(id) => self
                .symbols
                .get(id)
                .map(|s| s.contours.as_slice())
                .ok_or_else(|| ModelError::UnknownSymbol(id.clone())),
            DrawingTarget::Alternate(id) => self
                .alternates
                .get(id)
                .map(|a| a.contours.as_slice())
                .ok_or_else(|| ModelError::UnknownAlternate(id.clone())),
            DrawingTarget::Brace(id) => self
                .design
                .braces
                .iter()
                .find(|b| &b.id == id)
                .map(|b| b.contours.as_slice())
                .ok_or_else(|| ModelError::UnknownBrace(id.clone())),
            DrawingTarget::Component(id) => {
                let (comp, state) = crate::parametric::state_ref(id);
                let c = self.components.get(comp).ok_or_else(|| ModelError::UnknownComponent(id.clone()))?;
                match state {
                    None => Ok(&c.contours),
                    Some(i) => c
                        .states
                        .get(i)
                        .map(|s| s.contours.as_slice())
                        .ok_or_else(|| ModelError::UnknownComponent(id.clone())),
                }
            }
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id)?;
                match &self.fidel(&family, order)?.state {
                    FidelState::Detached { contours } => Ok(contours),
                    _ => Err(ModelError::NotDrawnByHand(family, order)),
                }
            }
        }
    }

    /// Replace the contours of a base or an alteration. Every fidel that uses
    /// it picks up the change on its next resolve. Rejects malformed contours.
    pub fn set_drawing(&mut self, target: &DrawingTarget, contours: Vec<Contour>) -> Result<(), ModelError> {
        let mut ids = std::collections::HashSet::new();
        for c in &contours {
            if !ids.insert(c.id) {
                return Err(ModelError::DuplicateContourId(c.id));
            }
            c.validate().map_err(|problem| ModelError::InvalidContour { contour: c.id, problem })?;
        }
        // A generated fidel edited in place: moved points become nudges.
        if let DrawingTarget::Fidel(id) = target {
            let (family, order) = DrawingTarget::fidel_ref(id)?;
            if !matches!(self.fidel(&family, order)?.state, FidelState::Detached { .. }) {
                return self.set_generated_outline(&family, order, &contours);
            }
        }
        let refresh = matches!(target, DrawingTarget::Base(_) | DrawingTarget::Alteration(_));
        let slot = match target {
            DrawingTarget::Base(id) => {
                let b = self.bases.get_mut(id).ok_or_else(|| ModelError::UnknownBase(id.clone()))?;
                // Drawing on a derived base makes it its own.
                if let Some(d) = b.derived.as_mut() {
                    if b.contours != contours {
                        d.own = true;
                    }
                }
                &mut b.contours
            }
            DrawingTarget::Alteration(id) => {
                &mut self
                    .alterations
                    .get_mut(id)
                    .ok_or_else(|| ModelError::UnknownAlteration(id.clone()))?
                    .contours
            }
            DrawingTarget::Symbol(id) => {
                let s = self.symbols.get_mut(id).ok_or_else(|| ModelError::UnknownSymbol(id.clone()))?;
                // Drawing on a built letter takes it over by hand.
                if !contours.is_empty() {
                    s.built_from.clear();
                }
                &mut s.contours
            }
            DrawingTarget::Alternate(id) => {
                &mut self
                    .alternates
                    .get_mut(id)
                    .ok_or_else(|| ModelError::UnknownAlternate(id.clone()))?
                    .contours
            }
            DrawingTarget::Brace(id) => {
                &mut self
                    .design
                    .braces
                    .iter_mut()
                    .find(|b| &b.id == id)
                    .ok_or_else(|| ModelError::UnknownBrace(id.clone()))?
                    .contours
            }
            DrawingTarget::Component(id) => {
                let (comp, state) = crate::parametric::state_ref(id);
                let c =
                    self.components.get_mut(comp).ok_or_else(|| ModelError::UnknownComponent(id.clone()))?;
                match state {
                    None => &mut c.contours,
                    Some(i) => {
                        &mut c
                            .states
                            .get_mut(i)
                            .ok_or_else(|| ModelError::UnknownComponent(id.clone()))?
                            .contours
                    }
                }
            }
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id)?;
                match &mut self.fidel_mut(&family, order)?.state {
                    FidelState::Detached { contours } => contours,
                    _ => return Err(ModelError::NotDrawnByHand(family, order)),
                }
            }
        };
        *slot = contours;
        if refresh || matches!(target, DrawingTarget::Symbol(_)) {
            self.after_edit();
        }
        Ok(())
    }

    /// Bring derived bases and metric keys up to date after an edit.
    pub fn after_edit(&mut self) {
        self.refresh_derived();
        self.apply_metric_keys();
    }

    /// Set the metric keys of a base (`base:la`) or symbol (`symbol:uni1361`)
    /// and apply them.
    pub fn set_metric_keys(
        &mut self,
        target: &DrawingTarget,
        keys: crate::metric_keys::MetricKeys,
    ) -> Result<(), ModelError> {
        let keys = keys.tidy();
        match target {
            DrawingTarget::Base(id) => {
                self.bases.get_mut(id).ok_or_else(|| ModelError::UnknownBase(id.clone()))?.metric_keys = keys
            }
            DrawingTarget::Symbol(id) => {
                self.symbols.get_mut(id).ok_or_else(|| ModelError::UnknownSymbol(id.clone()))?.metric_keys =
                    keys
            }
            _ => return Err(ModelError::NoMetrics),
        }
        self.after_edit();
        Ok(())
    }

    /// Rebuild every base that follows another (ሸ from ሰ + cap). Call after
    /// any change to a base or an alteration.
    pub fn refresh_derived(&mut self) {
        // Twice, so a base derived from a derived base catches up.
        for _ in 0..2 {
            let ids: Vec<String> =
                self.bases.values().filter(|b| b.follows()).map(|b| b.id.clone()).collect();
            for id in ids {
                if let Some((contours, advance, components, anchors)) = self.derived_outline(&id) {
                    let b = self.bases.get_mut(&id).expect("listed above");
                    b.contours = contours;
                    b.advance_width = advance;
                    b.components = components;
                    b.anchors = anchors;
                }
            }
        }
    }

    /// A derived base's outline: its source base with the added marks placed
    /// on it, the advance grown to keep the right sidebearing. `None` when the
    /// base is not derived or its source is missing.
    #[allow(clippy::type_complexity)]
    pub fn derived_outline(
        &self,
        id: &str,
    ) -> Option<(Vec<Contour>, f64, Vec<crate::component::ComponentRef>, BTreeMap<String, Vec2>)> {
        let d = self.bases.get(id)?.derived.as_ref()?;
        let src = self.bases.get(&d.from).filter(|s| s.id != id)?;
        let mut contours = src.contours.clone();
        let mut next = contours.iter().map(|c| c.id + 1).max().unwrap_or(0);
        let family = self.families.values().find(|f| f.base == id).map(|f| f.id.clone()).unwrap_or_default();
        for alt_id in &d.adds {
            let Some(alt) = self.alterations.get(alt_id) else { continue };
            if !alt.verb.is_additive() || alt.contours.is_empty() {
                continue;
            }
            let Some(attach) = alt.placement.attach_point(src) else { continue };
            let mut at = attach.at;
            if let Some(y) = alt.zone.as_deref().and_then(|z| self.metrics.zone_y(z)) {
                at.y = y;
            }
            let shift = at + self.attach_offset(&family, alt_id);
            for c in &alt.contours {
                let mut c = c.clone();
                c.translate(shift);
                c.id = next;
                next += 1;
                contours.push(c);
            }
        }
        let mut advance = src.advance_width;
        if let (Some(sb), Some(all)) =
            (crate::geometry::bounds_of(&src.contours), crate::geometry::bounds_of(&contours))
        {
            advance = advance.max(all.max.x + (src.advance_width - sb.max.x));
        }
        Some((contours, advance, src.components.clone(), src.anchors.clone()))
    }

    /// Make a derived base follow its source again, or keep its own drawing.
    pub fn set_base_follows(&mut self, id: &str, follows: bool) -> Result<(), ModelError> {
        let b = self.bases.get_mut(id).ok_or_else(|| ModelError::UnknownBase(id.into()))?;
        if let Some(d) = b.derived.as_mut() {
            d.own = !follows;
        }
        self.after_edit();
        Ok(())
    }

    /// A generated fidel's outline for editing in place: its resolved
    /// contours, with contour ids replaced by their position so ids from the
    /// base and from the marks don't clash.
    pub fn generated_outline(&self, family: &str, order: Order) -> Result<Vec<Contour>, ModelError> {
        Ok(self
            .resolve(family, order)?
            .contours
            .into_iter()
            .filter(|rc| !matches!(rc.source, Source::Placed(_)))
            .enumerate()
            .map(|(i, rc)| Contour { id: i as u32, ..rc.contour })
            .collect())
    }

    /// Save an edit to a generated fidel (from [`Project::generated_outline`]).
    /// Moved points become nudges, so they survive changes to the base and
    /// the marks. Adding or removing points or contours draws the fidel by
    /// hand, with the edited outline as its drawing.
    pub fn set_generated_outline(
        &mut self,
        family: &str,
        order: Order,
        contours: &[Contour],
    ) -> Result<(), ModelError> {
        let mut resolved = self.resolve(family, order)?;
        resolved.contours.retain(|rc| !matches!(rc.source, Source::Placed(_)));
        let same_points = resolved.contours.len() == contours.len()
            && resolved.contours.iter().zip(contours).all(|(rc, edited)| {
                rc.contour.points.len() == edited.points.len()
                    && rc.contour.points.iter().zip(&edited.points).all(|(a, b)| a.id == b.id)
            });
        if !same_points {
            self.fidel_mut(family, order)?.state = FidelState::Detached { contours: contours.to_vec() };
            return Ok(());
        }
        let mut moves = Vec::new();
        for (rc, edited) in resolved.contours.iter().zip(contours) {
            for (a, b) in rc.contour.points.iter().zip(&edited.points) {
                let d = b.pos - a.pos;
                if d.x.abs() > 1e-9 || d.y.abs() > 1e-9 {
                    let target =
                        NudgeTarget::Point { source: rc.source.clone(), contour: rc.contour.id, point: a.id };
                    moves.push((target, d));
                }
            }
        }
        for (target, d) in moves {
            self.nudge(family, order, target, d)?;
        }
        Ok(())
    }

    pub fn fidel(&self, family: &str, order: Order) -> Result<&Fidel, ModelError> {
        self.families
            .get(family)
            .ok_or_else(|| ModelError::UnknownFamily(family.into()))?
            .fidels
            .get(&order)
            .ok_or_else(|| ModelError::UnknownFidel(family.into(), order))
    }

    pub(crate) fn fidel_mut(&mut self, family: &str, order: Order) -> Result<&mut Fidel, ModelError> {
        self.families
            .get_mut(family)
            .ok_or_else(|| ModelError::UnknownFamily(family.into()))?
            .fidels
            .get_mut(&order)
            .ok_or_else(|| ModelError::UnknownFidel(family.into(), order))
    }

    /// The alterations that build this fidel: the form its family picked
    /// for this order, with the fidel's own copies swapped in.
    pub fn effective_alterations(&self, family: &str, order: Order) -> Result<Vec<AlterationId>, ModelError> {
        let fidel = self.fidel(family, order)?;
        let mut alts = self.rule_alterations(family, order);
        for a in &mut alts {
            if let Some(own) = fidel.alteration_overrides.get(a) {
                a.clone_from(own);
            }
        }
        Ok(alts)
    }

    /// The order rule's alterations for this fidel, before its own copies
    /// (see [`crate::scope`]) are swapped in.
    pub(crate) fn rule_alterations(&self, family: &str, order: Order) -> Vec<AlterationId> {
        let variant =
            self.families.get(family).and_then(|f| f.rule_variants.get(&order).copied()).unwrap_or(0);
        self.order_rules
            .get(&order)
            .and_then(|r| r.variant(variant).or_else(|| r.variant(0)))
            .map(<[_]>::to_vec)
            .unwrap_or_default()
    }

    /// Resolve one fidel into outlines.
    pub fn resolve(&self, family: &str, order: Order) -> Result<ResolvedFidel, ModelError> {
        self.fidel(family, order)?;
        Ok(resolve::resolve(self, family, order).expect("fidel exists"))
    }

    /// Resolve every fidel of one order, in family order. This is the
    /// Alteration view's "see it on every family at once".
    pub fn resolve_order(&self, order: Order) -> Vec<ResolvedFidel> {
        self.families.keys().filter_map(|f| resolve::resolve(self, f, order)).collect()
    }

    /// Move one point (or a whole placed alteration) of a generated fidel.
    /// A Linked fidel becomes Adjusted. Repeated nudges on the same target add up.
    pub fn nudge(
        &mut self,
        family: &str,
        order: Order,
        target: NudgeTarget,
        delta: Vec2,
    ) -> Result<(), ModelError> {
        let fidel = self.fidel_mut(family, order)?;
        match &mut fidel.state {
            FidelState::Linked => {
                fidel.state = FidelState::Adjusted { nudges: Vec::new() };
                if let FidelState::Adjusted { nudges } = &mut fidel.state {
                    merge_nudge(nudges, target, delta);
                }
            }
            FidelState::Adjusted { nudges } => merge_nudge(nudges, target, delta),
            other => return Err(ModelError::NotGenerated(other.kind())),
        }
        Ok(())
    }

    /// Drop all local edits and go back to the order rule.
    pub fn relink(&mut self, family: &str, order: Order) -> Result<(), ModelError> {
        self.fidel_mut(family, order)?.state = FidelState::Linked;
        Ok(())
    }

    /// Bake the current outline into a hand-drawn copy that no longer updates.
    pub fn detach(&mut self, family: &str, order: Order) -> Result<(), ModelError> {
        let resolved = self.resolve(family, order)?;
        // Each contour keeps a name saying where it came from, so the order
        // mark is still recognisable as its own layer.
        let contours: Vec<Contour> = resolved
            .contours
            .into_iter()
            .filter(|rc| !matches!(rc.source, Source::Placed(_)))
            .enumerate()
            .map(|(i, rc)| {
                let name = rc.contour.name.clone().or_else(|| match &rc.source {
                    Source::Base => {
                        Some(rc.contour.part.map_or("Base".to_string(), |p| capitalise(&format!("{p:?}"))))
                    }
                    Source::Alteration(id) => {
                        Some(self.alterations.get(id).map_or_else(|| id.clone(), |a| a.name.clone()))
                    }
                    Source::Own => None,
                    Source::Leaf(_) => Some(
                        self.components.get(id_of_leaf(&rc.source)).map_or("Leaf".into(), |c| c.name.clone()),
                    ),
                    Source::Placed(_) => None,
                    Source::Component(_) => Some(
                        rc.contour.part.map_or("Component".to_string(), |p| capitalise(&format!("{p:?}"))),
                    ),
                });
                Contour { id: i as u32, name, ..rc.contour }
            })
            .collect();
        self.fidel_mut(family, order)?.state = FidelState::Detached { contours };
        Ok(())
    }

    /// "Draw it": the fidel is drawn by hand from now on. It starts from a
    /// copy of what it generates today, so nothing jumps.
    pub fn draw_by_hand(&mut self, family: &str, order: Order) -> Result<(), ModelError> {
        if matches!(self.fidel(family, order)?.state, FidelState::Detached { ref contours } if !contours.is_empty())
        {
            return Ok(());
        }
        self.detach(family, order)
    }

    /// The "what will change" preview: every fidel that uses `change`, and
    /// what will happen to it.
    pub fn impacts(&self, change: &Change) -> Vec<Impact> {
        let mut out = Vec::new();
        for (fam_id, family) in &self.families {
            for (order, fidel) in &family.fidels {
                if !self.depends_on(change, fam_id, *order, &mut Vec::new()) {
                    continue;
                }
                let effect = match &fidel.state {
                    FidelState::Detached { contours } if !contours.is_empty() => Effect::Untouched,
                    s if s.nudges().is_empty() => Effect::Regenerates,
                    _ => Effect::RegeneratesKeepingNudges,
                };
                out.push(Impact { family: fam_id.clone(), order: *order, state: fidel.state.kind(), effect });
            }
        }
        out
    }

    /// Whether `change` reaches this fidel: it uses the base or alteration
    /// itself, or is built on a fidel that does.
    fn depends_on(&self, change: &Change, family: &str, order: Order, chain: &mut Vec<Order>) -> bool {
        let Some(fam) = self.families.get(family) else { return false };
        // A base that follows another (ሸ from ሰ) changes with it, and with
        // the marks added to it.
        let derived = self.bases.get(&fam.base).and_then(|b| b.derived.as_ref().filter(|_| b.follows()));
        let direct = match change {
            Change::Base(id) => &fam.base == id || derived.is_some_and(|d| &d.from == id),
            Change::Alteration(id) => {
                self.effective_alterations(family, order).map(|a| a.contains(id)).unwrap_or(false)
                    || derived.is_some_and(|d| d.adds.contains(id))
            }
        };
        if direct {
            return true;
        }
        let Some(parent) = fam.fidels.get(&order).and_then(|f| f.built_on) else { return false };
        if parent == order || chain.contains(&parent) {
            return false;
        }
        chain.push(order);
        let reached = self.depends_on(change, family, parent, chain);
        chain.pop();
        reached
    }

    /// Build this fidel on another order of its family (`Some`), or on the
    /// bare base again (`None`). Refuses a link that would loop back.
    pub fn set_built_on(&mut self, family: &str, order: Order, on: Option<Order>) -> Result<(), ModelError> {
        if let Some(parent) = on {
            self.fidel(family, parent)?;
            // Walk up from the parent; reaching `order` means a loop.
            let mut at = Some(parent);
            let mut steps = 0;
            while let Some(o) = at {
                if o == order || steps > Order::ALL.len() + Order::EXTRA.len() {
                    return Err(ModelError::BuiltOnCycle(parent));
                }
                at = self.fidel(family, o)?.built_on;
                steps += 1;
            }
        }
        self.fidel_mut(family, order)?.built_on = on;
        Ok(())
    }

    /// How far this family moves an alteration from its automatic attach
    /// point. A copy made by a scoped edit follows its original's offset
    /// unless it has one of its own.
    pub fn attach_offset(&self, family: &str, alteration: &str) -> Vec2 {
        let Some(fam) = self.families.get(family) else { return Vec2::ZERO };
        fam.attach_offsets
            .get(alteration)
            .or_else(|| {
                let original = self.alterations.get(alteration)?.forked_from.as_ref()?;
                fam.attach_offsets.get(original)
            })
            .copied()
            .unwrap_or(Vec2::ZERO)
    }

    /// The automatic attach point of `alteration` on this family's base,
    /// before the family's own offset.
    pub fn auto_attach_point(&self, family: &str, alteration: &str) -> Option<Vec2> {
        let fam = self.families.get(family)?;
        let base = self.bases.get(&fam.base)?;
        Some(self.alterations.get(alteration)?.placement.attach_point(base)?.at)
    }

    /// Move where `alteration` attaches on every fidel of this family.
    /// A zero offset goes back to the automatic point.
    pub fn set_attach_offset(
        &mut self,
        family: &str,
        alteration: &str,
        offset: Vec2,
    ) -> Result<(), ModelError> {
        if !self.alterations.contains_key(alteration) {
            return Err(ModelError::UnknownAlteration(alteration.into()));
        }
        let fam = self.families.get_mut(family).ok_or_else(|| ModelError::UnknownFamily(family.into()))?;
        if offset == Vec2::ZERO {
            fam.attach_offsets.remove(alteration);
        } else {
            fam.attach_offsets.insert(alteration.into(), offset);
        }
        self.after_edit();
        Ok(())
    }

    /// The fidel of this family built on `order`, directly.
    pub fn built_on_by(&self, family: &str, order: Order) -> Vec<Order> {
        self.families
            .get(family)
            .map(|f| f.fidels.iter().filter(|(_, x)| x.built_on == Some(order)).map(|(o, _)| *o).collect())
            .unwrap_or_default()
    }

    /// Pick which variant of an order rule this family uses (Hornus: the 4th
    /// order shortens the left leg in most families and stretches the stem
    /// in ቃ ታ ና). Variant 0 is the rule's default.
    pub fn set_rule_variant(&mut self, family: &str, order: Order, variant: usize) -> Result<(), ModelError> {
        let count = self.order_rules.get(&order).map_or(0, |r| r.variants.len());
        if variant >= count.max(1) {
            return Err(ModelError::NoSuchVariant(order, variant));
        }
        let fam = self.families.get_mut(family).ok_or_else(|| ModelError::UnknownFamily(family.into()))?;
        if variant == 0 {
            fam.rule_variants.remove(&order);
        } else {
            fam.rule_variants.insert(order, variant);
        }
        Ok(())
    }

    /// Pick how this fidel's order is formed: one of the order's forms for
    /// the whole family (and this fidel goes back to being generated), or
    /// "Draw it" for this fidel alone.
    pub fn set_form(
        &mut self,
        family: &str,
        order: Order,
        form: crate::ethiopic::Form,
    ) -> Result<(), ModelError> {
        match form {
            crate::ethiopic::Form::Draw => self.draw_by_hand(family, order),
            crate::ethiopic::Form::Variant(v) => {
                self.set_rule_variant(family, order, v)?;
                if matches!(self.fidel(family, order)?.state, FidelState::Detached { .. }) {
                    self.relink(family, order)?;
                }
                Ok(())
            }
        }
    }

    /// Set where a deforming alteration lands and how far it pulls.
    pub fn set_deform(
        &mut self,
        alteration: &str,
        zone: Option<String>,
        amount: Option<f64>,
    ) -> Result<(), ModelError> {
        let alt = self
            .alterations
            .get_mut(alteration)
            .ok_or_else(|| ModelError::UnknownAlteration(alteration.into()))?;
        alt.zone = zone;
        alt.amount = amount;
        Ok(())
    }

    /// Add an empty component and return its id.
    pub fn add_component(&mut self, name: &str, kind: crate::component::ComponentKind) -> ComponentId {
        let stem: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string();
        let stem = if stem.is_empty() { format!("{kind:?}").to_lowercase() } else { stem };
        let mut id = stem.clone();
        let mut n = 2;
        while self.components.contains_key(&id) {
            id = format!("{stem}-{n}");
            n += 1;
        }
        self.components.insert(id.clone(), Component::new(id.clone(), name, kind));
        id
    }

    /// Remove a component and every placement of it.
    pub fn remove_component(&mut self, id: &str) -> Result<(), ModelError> {
        self.components.remove(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        for b in self.bases.values_mut() {
            b.components.retain(|r| r.component != id);
        }
        for s in self.symbols.values_mut() {
            s.components.retain(|r| r.component != id);
        }
        for f in self.families.values_mut() {
            for fi in f.fidels.values_mut() {
                fi.components.retain(|r| r.component != id);
            }
        }
        Ok(())
    }

    /// Set where a component lands by rule: on which parts, and for a corner
    /// component, which corners.
    pub fn set_component_rule(
        &mut self,
        id: &str,
        lands_on: Vec<crate::parts::Part>,
        corners: crate::component::CornerSide,
    ) -> Result<(), ModelError> {
        let c = self.components.get_mut(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        c.lands_on = lands_on;
        c.corners = corners;
        Ok(())
    }

    /// Switch one rule placement on or off, and set how it is adjusted.
    pub fn set_component_end(
        &mut self,
        id: &str,
        key: &str,
        on: bool,
        tweak: crate::component::Tweak,
    ) -> Result<(), ModelError> {
        let c = self.components.get_mut(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        if on {
            c.off.remove(key);
        } else {
            c.off.insert(key.into());
        }
        if tweak.is_identity() {
            c.tweaks.remove(key);
        } else {
            c.tweaks.insert(key.into(), tweak);
        }
        Ok(())
    }

    /// Every rule placement on a base's own strokes, the ones switched off
    /// included, with the component it places.
    pub fn rule_ends(&self, base: &str) -> Vec<(&Component, crate::component::End)> {
        let Some(b) = self.bases.get(base) else { return Vec::new() };
        let mut out = Vec::new();
        for comp in self.components.values().filter(|c| !c.lands_on.is_empty()) {
            for c in &b.contours {
                out.extend(comp.all_ends(base, c).into_iter().map(|e| (comp, e)));
            }
        }
        out
    }

    /// How many times a component lands by rule across the bases.
    pub fn rule_uses(&self, id: &str) -> usize {
        let Some(comp) = self.components.get(id) else { return 0 };
        self.bases
            .iter()
            .map(|(bid, b)| b.contours.iter().map(|c| comp.ends(bid, c).len()).sum::<usize>())
            .sum()
    }

    /// A symbol's outline: its own contours and the components placed on it.
    pub fn symbol_outline(&self, id: &str) -> Vec<Contour> {
        let Some(s) = self.symbols.get(id) else { return Vec::new() };
        if !s.built_from.is_empty() {
            return self.compose(s.built_from[0], &s.built_from[1..]).map(|g| g.contours).unwrap_or_default();
        }
        let mut out = s.contours.clone();
        for r in &s.components {
            if let Some(comp) = self.components.get(&r.component) {
                out.extend(r.place_in(comp, &self.design.font_location()));
            }
        }
        out
    }

    /// A symbol's width: a built letter takes its base letter's.
    pub fn symbol_advance(&self, id: &str) -> f64 {
        let Some(s) = self.symbols.get(id) else { return 0.0 };
        if !s.built_from.is_empty() {
            if let Some(g) = self.compose(s.built_from[0], &s.built_from[1..]) {
                return g.advance;
            }
        }
        s.advance_width
    }

    /// Replace the component placements on a symbol.
    pub fn set_symbol_components(
        &mut self,
        symbol: &str,
        refs: Vec<crate::component::ComponentRef>,
    ) -> Result<(), ModelError> {
        let mut ids = std::collections::HashSet::new();
        for r in &refs {
            if !self.components.contains_key(&r.component) {
                return Err(ModelError::UnknownComponent(r.component.clone()));
            }
            if !ids.insert(r.id) {
                return Err(ModelError::DuplicatePlacementId(r.id));
            }
        }
        self.symbols.get_mut(symbol).ok_or_else(|| ModelError::UnknownSymbol(symbol.into()))?.components =
            refs;
        Ok(())
    }

    /// Replace the component placements on one fidel.
    pub fn set_fidel_components(
        &mut self,
        family: &str,
        order: crate::order::Order,
        refs: Vec<crate::component::ComponentRef>,
    ) -> Result<(), ModelError> {
        let mut ids = std::collections::HashSet::new();
        for r in &refs {
            if !self.components.contains_key(&r.component) {
                return Err(ModelError::UnknownComponent(r.component.clone()));
            }
            if !ids.insert(r.id) {
                return Err(ModelError::DuplicatePlacementId(r.id));
            }
        }
        let fam = self.families.get_mut(family).ok_or_else(|| ModelError::UnknownFamily(family.into()))?;
        fam.fidels
            .get_mut(&order)
            .ok_or_else(|| ModelError::UnknownFidel(family.into(), order))?
            .components = refs;
        self.after_edit();
        Ok(())
    }

    /// Replace the component placements on a base.
    pub fn set_base_components(
        &mut self,
        base: &str,
        refs: Vec<crate::component::ComponentRef>,
    ) -> Result<(), ModelError> {
        let mut ids = std::collections::HashSet::new();
        for r in &refs {
            if !self.components.contains_key(&r.component) {
                return Err(ModelError::UnknownComponent(r.component.clone()));
            }
            if !ids.insert(r.id) {
                return Err(ModelError::DuplicatePlacementId(r.id));
            }
        }
        self.bases.get_mut(base).ok_or_else(|| ModelError::UnknownBase(base.into()))?.components = refs;
        self.after_edit();
        Ok(())
    }
}

fn capitalise(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut c = lower.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// The component id of a rule-placed component's source.
fn id_of_leaf(source: &Source) -> &str {
    match source {
        Source::Leaf(key) => key.split('@').next().unwrap_or(""),
        _ => "",
    }
}
