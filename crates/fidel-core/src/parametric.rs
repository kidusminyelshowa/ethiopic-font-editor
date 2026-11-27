//! Parametric parts: a leaf, cap or corner with axes of its own, such as a
//! leaf's size, drawn in two or more states and set anywhere between them
//! per placement, or tied to a font axis.
//!
//! A state is edited as the drawing `component#n` (n from 1); its outline is
//! kept per master like the part's main drawing.

use serde::Serialize;

use crate::component::{PartAxis, PartState, PartValues};
use crate::geometry::Contour;
use crate::project::{ModelError, Project};

/// `leaf#2` is the second state of `leaf`; `leaf` is its main drawing.
pub fn state_ref(id: &str) -> (&str, Option<usize>) {
    match id.rsplit_once('#') {
        Some((c, n)) => match n.parse::<usize>() {
            Ok(n) if n >= 1 => (c, Some(n - 1)),
            _ => (id, None),
        },
        None => (id, None),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PartError {
    #[error(transparent)]
    Model(#[from] ModelError),
    #[error("An axis needs a name")]
    EmptyName,
    #[error("Two axes are called “{0}”")]
    Duplicate(String),
    #[error("“{0}” needs min ≤ default ≤ max, and min below max")]
    BadRange(String),
    #[error("No state {0}")]
    NoState(usize),
    #[error("Add an axis first")]
    NoAxes,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    pub location: PartValues,
    /// Why it does not interpolate with the main drawing.
    pub problem: Option<String>,
}

/// A part's axes and states, for the inspector.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartView {
    pub id: String,
    pub axes: Vec<PartAxis>,
    pub states: Vec<StateView>,
    /// The font's axes a part axis can follow: tag and name.
    pub font_axes: Vec<(String, String)>,
}

impl Project {
    /// The part's outline at these settings, for previewing a placement.
    pub fn part_preview(&self, id: &str, values: &PartValues) -> Result<Vec<Contour>, ModelError> {
        let c = self.components.get(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        Ok(c.shape(values))
    }

    pub fn part_view(&self, id: &str) -> Result<PartView, ModelError> {
        let c = self.components.get(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        Ok(PartView {
            id: id.into(),
            axes: c.axes.clone(),
            states: (0..c.states.len())
                .map(|i| StateView { location: c.states[i].location.clone(), problem: c.state_problem(i) })
                .collect(),
            font_axes: self.design.axes.iter().map(|a| (a.tag.clone(), a.name.clone())).collect(),
        })
    }

    /// Replace a part's axes. State locations and placement settings of
    /// axes that are gone are dropped.
    pub fn set_part_axes(&mut self, id: &str, axes: Vec<PartAxis>) -> Result<(), PartError> {
        let mut names = Vec::new();
        for a in &axes {
            let n = a.name.trim();
            if n.is_empty() {
                return Err(PartError::EmptyName);
            }
            if names.contains(&n) {
                return Err(PartError::Duplicate(n.into()));
            }
            if !(a.min <= a.default && a.default <= a.max && a.min < a.max) {
                return Err(PartError::BadRange(n.into()));
            }
            names.push(n);
        }
        let names: Vec<String> = names.into_iter().map(String::from).collect();
        let c = self.components.get_mut(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        c.axes = axes
            .into_iter()
            .map(|mut a| {
                a.name = a.name.trim().into();
                a.follows = a.follows.filter(|t| !t.is_empty());
                a
            })
            .collect();
        let keep = |v: &mut PartValues| v.retain(|k, _| names.contains(k));
        c.states.iter_mut().for_each(|s| keep(&mut s.location));
        c.tweaks.values_mut().for_each(|t| keep(&mut t.values));
        if c.axes.is_empty() {
            c.states.clear();
        }
        let refs = self
            .bases
            .values_mut()
            .flat_map(|b| b.components.iter_mut())
            .chain(self.symbols.values_mut().flat_map(|s| s.components.iter_mut()));
        for r in refs.filter(|r| r.component == id) {
            keep(&mut r.values);
        }
        self.for_other_masters(id, |_| {});
        Ok(())
    }

    /// Add a state, drawn as a copy of the main drawing, at a location.
    /// Every master gets one, copied from its own main drawing. Returns its
    /// number (from 1).
    pub fn add_part_state(&mut self, id: &str, location: PartValues) -> Result<usize, PartError> {
        let c = self.components.get_mut(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        if c.axes.is_empty() {
            return Err(PartError::NoAxes);
        }
        c.states.push(PartState { location, contours: c.contours.clone() });
        let n = c.states.len();
        self.for_other_masters(id, |(main, states)| states.push(main.clone()));
        Ok(n)
    }

    /// Move a state to another location.
    pub fn set_part_state(&mut self, id: &str, index: usize, location: PartValues) -> Result<(), PartError> {
        let c = self.components.get_mut(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        let s = c.states.get_mut(index).ok_or(PartError::NoState(index + 1))?;
        s.location = location;
        Ok(())
    }

    pub fn remove_part_state(&mut self, id: &str, index: usize) -> Result<(), PartError> {
        let c = self.components.get_mut(id).ok_or_else(|| ModelError::UnknownComponent(id.into()))?;
        if index >= c.states.len() {
            return Err(PartError::NoState(index + 1));
        }
        c.states.remove(index);
        self.for_other_masters(id, |(_, states)| {
            if index < states.len() {
                states.remove(index);
            }
        });
        Ok(())
    }

    /// Change a part's states in every master that is not being edited,
    /// then line their count up with the active master's.
    fn for_other_masters(
        &mut self,
        id: &str,
        mut f: impl FnMut((&Vec<crate::geometry::Contour>, &mut Vec<Vec<crate::geometry::Contour>>)),
    ) {
        let Some(c) = self.components.get(id) else { return };
        let (count, main_now) = (c.states.len(), c.contours.clone());
        let active = self.design.active;
        for (i, m) in self.design.masters.iter_mut().enumerate() {
            if i == active {
                continue;
            }
            let Some(layer) = m.layer.as_mut() else { continue };
            let main = layer.components.get(id).cloned().unwrap_or_else(|| main_now.clone());
            let states = layer.part_states.entry(id.to_string()).or_default();
            f((&main, states));
            states.resize(count, main.clone());
            if states.is_empty() {
                layer.part_states.remove(id);
            }
        }
    }
}
