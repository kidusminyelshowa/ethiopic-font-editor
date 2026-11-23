//! The project: everything a .kid file will hold for one master.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::alteration::{Alteration, AlterationId};
use crate::base::{Base, BaseId};
use crate::charset::{CharSet, Language};
use crate::fidel::{
    merge_nudge, Family, FamilyId, Fidel, FidelState, IrregularForm, NudgeTarget, Source, StateKind,
};
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
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics { units_per_em: 1000, pa_top: 700.0, pa_bottom: 0.0 }
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
}

impl Default for FontInfo {
    fn default() -> Self {
        FontInfo {
            family_name: String::new(),
            style_name: "Regular".into(),
            version: 1.0,
            designer: String::new(),
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
}

#[derive(Debug, Error, PartialEq)]
pub enum ModelError {
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
}

/// A drawing the glyph editor can open: a base, an alteration, a symbol, or
/// a fidel drawn by hand (Detached or Irregular drawn), as `family/order`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "kind", content = "id")]
pub enum DrawingTarget {
    Base(BaseId),
    Alteration(AlterationId),
    Symbol(SymbolId),
    Fidel(String),
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
    /// Uses the changed thing but will not update (Detached or drawn Irregular).
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
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id)?;
                match &self.fidel(&family, order)?.state {
                    FidelState::Detached { contours }
                    | FidelState::Irregular { form: IrregularForm::Drawn { contours }, .. } => Ok(contours),
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
        let slot = match target {
            DrawingTarget::Base(id) => {
                &mut self.bases.get_mut(id).ok_or_else(|| ModelError::UnknownBase(id.clone()))?.contours
            }
            DrawingTarget::Alteration(id) => {
                &mut self
                    .alterations
                    .get_mut(id)
                    .ok_or_else(|| ModelError::UnknownAlteration(id.clone()))?
                    .contours
            }
            DrawingTarget::Symbol(id) => {
                &mut self.symbols.get_mut(id).ok_or_else(|| ModelError::UnknownSymbol(id.clone()))?.contours
            }
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id)?;
                match &mut self.fidel_mut(&family, order)?.state {
                    FidelState::Detached { contours }
                    | FidelState::Irregular { form: IrregularForm::Drawn { contours }, .. } => contours,
                    _ => return Err(ModelError::NotDrawnByHand(family, order)),
                }
            }
        };
        *slot = contours;
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

    /// The alterations that build this fidel: its own recipe if Irregular,
    /// otherwise the order rule (in the variant the family picked).
    pub fn effective_alterations(&self, family: &str, order: Order) -> Result<Vec<AlterationId>, ModelError> {
        let fidel = self.fidel(family, order)?;
        if let FidelState::Irregular { form: IrregularForm::Recipe { alterations, .. }, .. } = &fidel.state {
            return Ok(alterations.clone());
        }
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
            FidelState::Adjusted { nudges }
            | FidelState::Irregular { form: IrregularForm::Recipe { nudges, .. }, .. } => {
                merge_nudge(nudges, target, delta)
            }
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
                });
                Contour { id: i as u32, name, ..rc.contour }
            })
            .collect();
        self.fidel_mut(family, order)?.state = FidelState::Detached { contours };
        Ok(())
    }

    /// Flag a fidel as irregular. It keeps its current alterations and nudges
    /// as its own recipe, so it still reuses the base and parts.
    pub fn mark_irregular(
        &mut self,
        family: &str,
        order: Order,
        note: Option<String>,
    ) -> Result<(), ModelError> {
        let alterations = self.effective_alterations(family, order)?;
        let fidel = self.fidel_mut(family, order)?;
        let nudges = fidel.state.nudges().to_vec();
        fidel.state = FidelState::Irregular { form: IrregularForm::Recipe { alterations, nudges }, note };
        Ok(())
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
                    FidelState::Detached { .. }
                    | FidelState::Irregular { form: IrregularForm::Drawn { .. }, .. } => Effect::Untouched,
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
        let direct = match change {
            Change::Base(id) => &fam.base == id,
            Change::Alteration(id) => {
                self.effective_alterations(family, order).map(|a| a.contains(id)).unwrap_or(false)
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
        Ok(())
    }

    /// The fidel of this family built on `order`, directly.
    pub fn built_on_by(&self, family: &str, order: Order) -> Vec<Order> {
        self.families
            .get(family)
            .map(|f| f.fidels.iter().filter(|(_, x)| x.built_on == Some(order)).map(|(o, _)| *o).collect())
            .unwrap_or_default()
    }
}

fn capitalise(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut c = lower.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}
