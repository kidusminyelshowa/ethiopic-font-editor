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
//! - **Detached**: drawn by hand ("Draw it"); no longer updates.
//!
//! Which alterations an order uses depends on the family: each order has a
//! short list of forms (ራብዕ shortens the left leg, or sweeps the stem, ...)
//! and each family picks one.
//!
//! Vocabulary and default rules follow Hornus, *The Ethiopic Writing System: A
//! Typographic Approach* (2006), sections 2.2 to 3.3.

/// Version of this crate, shown in the app's About line.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod alteration;
pub mod base;
pub mod charset;
pub mod component;
pub mod coverage;
pub mod defaults;
pub mod deform;
pub mod ethiopic;
pub mod fidel;
pub mod geometry;
pub mod kid;
pub mod order;
pub mod parts;
pub mod pathops;
pub mod project;
pub mod resolve;
pub mod scope;

pub use alteration::{Alteration, AlterationId, Placement, Region, Verb};
pub use base::{Base, BaseId};
pub use charset::{CharSet, Language};
pub use component::{Component, ComponentId, ComponentKind, ComponentRef};
pub use ethiopic::{Form, GeezFamily, ShapeGroup, GEEZ_FAMILIES};
pub use fidel::{Badge, Family, FamilyId, Fidel, FidelState, Nudge, NudgeTarget, Source, StateKind};
pub use geometry::{svg_path, Contour, ContourId, ContourProblem, Point, PointId, PointKind, Rect, Vec2};
pub use order::{Order, OrderRule};
pub use parts::Part;
pub use project::FontInfo;
pub use project::{
    Change, DrawingTarget, Effect, Impact, Metrics, ModelError, Project, Symbol, SymbolId, Zone,
};
pub use resolve::{DeformHandle, Diagnostic, ResolvedContour, ResolvedFidel};
pub use scope::Scope;
