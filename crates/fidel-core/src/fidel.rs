//! Families, fidel and the four glyph states.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::alteration::AlterationId;
use crate::base::BaseId;
use crate::ethiopic::ShapeGroup;
use crate::geometry::{Contour, ContourId, PointId, Vec2};
use crate::order::Order;

pub type FamilyId = String;

/// One consonant across its orders: a row of the Fidel Grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Family {
    pub id: FamilyId,
    pub name: String,
    pub base: BaseId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<ShapeGroup>,
    /// Which variant of each order rule this family uses, when not the default
    /// (variant 0).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub rule_variants: BTreeMap<Order, usize>,
    pub fidels: BTreeMap<Order, Fidel>,
}

/// One cell of the grid: a family at one order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fidel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codepoint: Option<char>,
    pub state: FidelState,
    /// Alterations this fidel uses in place of the ones its order rule names:
    /// rule alteration id -> its own copy. Set by scoped edits.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub alteration_overrides: BTreeMap<AlterationId, AlterationId>,
    /// Another order of the same family whose outline this fidel starts from,
    /// in place of the bare base. ሚ and ሜ are built on ማ: change ማ and they
    /// follow. The order rule's alterations are added on top as usual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_on: Option<Order>,
}

/// Where a contour in a resolved fidel came from. Nudges use it to find their
/// point again after regeneration.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "from", content = "id")]
pub enum Source {
    /// The family's base.
    Base,
    /// A placed alteration.
    Alteration(AlterationId),
    /// Drawn directly on this fidel (Irregular drawn, or Detached).
    Own,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "kind")]
pub enum NudgeTarget {
    /// Move one point of a generated contour.
    Point { source: Source, contour: ContourId, point: PointId },
    /// Shift a whole placed alteration ("a shifted marker").
    Placement { alteration: AlterationId },
}

/// A local edit on top of a generated fidel. Stored as an offset against a
/// stable point id, so it survives changes to the base or alteration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Nudge {
    pub target: NudgeTarget,
    pub delta: Vec2,
}

/// Every fidel has exactly one state, always visible as a badge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "state")]
pub enum FidelState {
    /// Fully generated from base + order rule; updates automatically.
    Linked,
    /// Generated, plus local nudges that survive upstream changes.
    Adjusted { nudges: Vec<Nudge> },
    /// The order rule does not apply. The fidel uses its own recipe (which may
    /// still reuse the base and other alterations) or a free drawing.
    Irregular {
        form: IrregularForm,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// Fully redrawn by hand; no longer receives updates.
    Detached { contours: Vec<Contour> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "form")]
pub enum IrregularForm {
    /// Base + its own list of alterations (e.g. ሙ keeps the መ bowls but has its
    /// own 2nd-order recipe). Updates when the base or those alterations change.
    Recipe {
        alterations: Vec<AlterationId>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        nudges: Vec<Nudge>,
    },
    /// Drawn freely; does not update.
    Drawn { contours: Vec<Contour> },
}

/// The state without its data, for badges and filters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StateKind {
    Linked,
    Adjusted,
    Irregular,
    Detached,
}

/// Grid badge for each state (from the brief).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Badge {
    None,
    Dot,
    Outlined,
    Solid,
}

impl StateKind {
    pub fn badge(self) -> Badge {
        match self {
            StateKind::Linked => Badge::None,
            StateKind::Adjusted => Badge::Dot,
            StateKind::Irregular => Badge::Outlined,
            StateKind::Detached => Badge::Solid,
        }
    }
}

impl FidelState {
    pub fn kind(&self) -> StateKind {
        match self {
            FidelState::Linked => StateKind::Linked,
            FidelState::Adjusted { .. } => StateKind::Adjusted,
            FidelState::Irregular { .. } => StateKind::Irregular,
            FidelState::Detached { .. } => StateKind::Detached,
        }
    }

    /// The nudges applied on top of generation, if this state has any.
    pub fn nudges(&self) -> &[Nudge] {
        match self {
            FidelState::Adjusted { nudges } => nudges,
            FidelState::Irregular { form: IrregularForm::Recipe { nudges, .. }, .. } => nudges,
            _ => &[],
        }
    }
}

/// Add `delta` to the nudge for `target`, or append a new nudge.
pub(crate) fn merge_nudge(nudges: &mut Vec<Nudge>, target: NudgeTarget, delta: Vec2) {
    match nudges.iter_mut().find(|n| n.target == target) {
        Some(n) => n.delta += delta,
        None => nudges.push(Nudge { target, delta }),
    }
}
