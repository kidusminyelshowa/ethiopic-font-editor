//! The fidel family system as a data model.
//!
//! Each fidel is a recipe, not a drawing: a [`Base`] plus the [`Alteration`]s
//! its [`OrderRule`] names, resolved into outlines on demand. Change the base or
//! an alteration once and every fidel that uses it updates, unless the designer
//! has taken it out of the system. Each fidel has exactly one [`FidelState`]:
//!
//! - **Linked**: fully generated; updates automatically.
//! - **Adjusted**: generated plus local nudges keyed to stable point ids, so
//!   the nudges survive upstream changes.
//! - **Irregular**: the rule does not apply; it has its own recipe (still
//!   reusing parts) or a free drawing.
//! - **Detached**: redrawn by hand; no longer updates.
//!
//! Vocabulary and default rules follow Hornus, *The Ethiopic Writing System: A
//! Typographic Approach* (2006), sections 2.2 to 3.3.

/// Version of this crate, shown in the app's About line.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod alteration;
pub mod base;
pub mod defaults;
pub mod ethiopic;
pub mod fidel;
pub mod geometry;
pub mod kid;
pub mod order;
pub mod parts;
pub mod project;
pub mod resolve;

pub use alteration::{Alteration, AlterationId, Placement, Region, Verb};
pub use base::{Base, BaseId};
pub use ethiopic::{GeezFamily, ShapeGroup, GEEZ_FAMILIES};
pub use fidel::{
    Badge, Family, FamilyId, Fidel, FidelState, IrregularForm, Nudge, NudgeTarget, Source, StateKind,
};
pub use geometry::{svg_path, Contour, ContourId, ContourProblem, Point, PointId, PointKind, Rect, Vec2};
pub use order::{Order, OrderRule};
pub use parts::Part;
pub use project::{Change, DrawingTarget, Effect, Impact, Metrics, ModelError, Project};
pub use resolve::{Diagnostic, ResolvedContour, ResolvedFidel};
