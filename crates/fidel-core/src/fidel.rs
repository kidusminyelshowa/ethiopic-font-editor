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
    /// Where this family's order marks sit, relative to the automatic attach
    /// point: alteration id -> offset. A loop that should hang lower on one
    /// family than on the others is moved here, once for the whole row.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attach_offsets: BTreeMap<AlterationId, Vec2>,
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
    /// Components placed on this fidel alone, on top of its outline: a
    /// leaf on a hand-drawn fidel, a dot on one order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<crate::component::ComponentRef>,
    /// Anchors of this order alone, in place of its base's: the 5th order's
    /// ring moves `bottom`. None takes the base's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchors: Option<std::collections::BTreeMap<String, crate::geometry::Vec2>>,
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
    /// Drawn directly on this fidel (Detached).
    Own,
    /// A component placed on the base, by its placement id.
    Component(u32),
    /// A component placed by rule on a stroke end (a leaf on a bar), as
    /// `component@owner/contour:side`.
    Leaf(String),
    /// A component placed on this fidel alone, by its placement id. Shown
    /// as a placement in the editor, not as editable contours.
    Placed(u32),
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
#[serde(rename_all = "lowercase", tag = "state", from = "StateRepr")]
pub enum FidelState {
    /// Fully generated from base + the family's form of its order; updates
    /// automatically.
    Linked,
    /// Generated, plus local nudges that survive upstream changes.
    Adjusted { nudges: Vec<Nudge> },
    /// Drawn by hand ("Draw it"): no longer generated. With no contours yet
    /// it shows the generated form as a starting point.
    Detached { contours: Vec<Contour> },
}

/// What older projects stored, including the retired Irregular state: its
/// recipe form keeps its nudges, its drawn form becomes a drawing.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase", tag = "state")]
enum StateRepr {
    Linked,
    Adjusted { nudges: Vec<Nudge> },
    Irregular { form: OldIrregular },
    Detached { contours: Vec<Contour> },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase", tag = "form")]
enum OldIrregular {
    Recipe {
        #[serde(default)]
        nudges: Vec<Nudge>,
    },
    Drawn {
        contours: Vec<Contour>,
    },
}

impl From<StateRepr> for FidelState {
    fn from(r: StateRepr) -> Self {
        match r {
            StateRepr::Linked => FidelState::Linked,
            StateRepr::Adjusted { nudges } => FidelState::Adjusted { nudges },
            StateRepr::Irregular { form: OldIrregular::Recipe { nudges } } if nudges.is_empty() => {
                FidelState::Linked
            }
            StateRepr::Irregular { form: OldIrregular::Recipe { nudges } } => FidelState::Adjusted { nudges },
            StateRepr::Irregular { form: OldIrregular::Drawn { contours } } => {
                FidelState::Detached { contours }
            }
            StateRepr::Detached { contours } => FidelState::Detached { contours },
        }
    }
}

/// The state without its data, for badges and filters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StateKind {
    Linked,
    Adjusted,
    Detached,
}

/// Grid badge for each state (from the brief).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Badge {
    None,
    Dot,
    Solid,
}

impl StateKind {
    pub fn badge(self) -> Badge {
        match self {
            StateKind::Linked => Badge::None,
            StateKind::Adjusted => Badge::Dot,
            StateKind::Detached => Badge::Solid,
        }
    }
}

impl FidelState {
    pub fn kind(&self) -> StateKind {
        match self {
            FidelState::Linked => StateKind::Linked,
            FidelState::Adjusted { .. } => StateKind::Adjusted,
            FidelState::Detached { .. } => StateKind::Detached,
        }
    }

    /// The nudges applied on top of generation, if this state has any.
    pub fn nudges(&self) -> &[Nudge] {
        match self {
            FidelState::Adjusted { nudges } => nudges,
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
