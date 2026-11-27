//! Brace layers: an extra drawing of one base or symbol at a location
//! between the masters, for a glyph that does not interpolate well on its
//! own (a counter that closes up halfway, a joint that kinks).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::designspace::{MasterLayer, Model};
use crate::geometry::Contour;
use crate::project::{DrawingTarget, ModelError, Project};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Brace {
    pub id: String,
    /// The base or symbol it is a drawing of.
    pub of: DrawingTarget,
    /// Design units by axis tag. A missing axis is at its default.
    #[serde(default)]
    pub location: BTreeMap<String, f64>,
    pub advance_width: f64,
    #[serde(default)]
    pub contours: Vec<Contour>,
}

/// A glyph's outline and width as numbers, for interpolating.
fn flat(contours: &[Contour], advance: f64) -> Vec<f64> {
    let mut v: Vec<f64> =
        contours.iter().flat_map(|c| c.points.iter().flat_map(|p| [p.pos.x, p.pos.y])).collect();
    v.push(advance);
    v
}

fn same_structure(a: &[Contour], b: &[Contour]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.points.len() == y.points.len() && x.points.iter().zip(&y.points).all(|(p, q)| p.kind == q.kind)
        })
}

/// A master layer's drawing of a base or symbol.
fn in_layer(l: &MasterLayer, of: &DrawingTarget) -> Option<(Vec<Contour>, f64)> {
    match of {
        DrawingTarget::Base(id) => l.bases.get(id).map(|b| (b.contours.clone(), b.advance_width)),
        DrawingTarget::Symbol(id) => l.symbols.get(id).map(|s| (s.contours.clone(), s.advance_width)),
        _ => None,
    }
}

impl Project {
    pub fn brace(&self, id: &str) -> Result<&Brace, ModelError> {
        self.design.braces.iter().find(|b| b.id == id).ok_or_else(|| ModelError::UnknownBrace(id.into()))
    }

    /// A brace's location, normalized per axis.
    pub fn brace_location(&self, b: &Brace) -> Vec<f64> {
        self.design
            .axes
            .iter()
            .map(|a| {
                a.normalize_design(b.location.get(&a.tag).copied().unwrap_or_else(|| a.to_design(a.default)))
            })
            .collect()
    }

    /// Add a brace layer of a base or symbol at a location in user units,
    /// starting from the drawing interpolated there.
    pub fn add_brace(
        &mut self,
        of: DrawingTarget,
        user: &BTreeMap<String, f64>,
    ) -> Result<String, ModelError> {
        if !matches!(of, DrawingTarget::Base(_) | DrawingTarget::Symbol(_)) {
            return Err(ModelError::NoBrace);
        }
        let location: BTreeMap<String, f64> = self
            .design
            .axes
            .iter()
            .map(|a| (a.tag.clone(), a.to_design(user.get(&a.tag).copied().unwrap_or(a.default))))
            .collect();
        let loc = self.design.user_location(user);
        let here = self.instance_at_loc(loc, true).unwrap_or_else(|_| self.clone());
        let contours = here.drawing(&of)?.to_vec();
        let advance_width = match &of {
            DrawingTarget::Base(id) => here.bases[id].advance_width,
            DrawingTarget::Symbol(id) => here.symbols[id].advance_width,
            _ => 0.0,
        };
        let mut n = self.design.braces.len() + 1;
        while self.design.braces.iter().any(|b| b.id == format!("b{n}")) {
            n += 1;
        }
        let id = format!("b{n}");
        self.design.braces.push(Brace { id: id.clone(), of, location, advance_width, contours });
        Ok(id)
    }

    pub fn remove_brace(&mut self, id: &str) -> Result<(), ModelError> {
        let n = self.design.braces.len();
        self.design.braces.retain(|b| b.id != id);
        if self.design.braces.len() == n {
            return Err(ModelError::UnknownBrace(id.into()));
        }
        Ok(())
    }

    pub fn set_brace_advance(&mut self, id: &str, advance: f64) -> Result<(), ModelError> {
        let b = self
            .design
            .braces
            .iter_mut()
            .find(|b| b.id == id)
            .ok_or_else(|| ModelError::UnknownBrace(id.into()))?;
        b.advance_width = advance.max(0.0);
        Ok(())
    }

    /// The brace layers of a base or symbol.
    pub fn braces_of(&self, of: &DrawingTarget) -> Vec<&Brace> {
        self.design.braces.iter().filter(|b| &b.of == of).collect()
    }

    /// Why a brace does not interpolate with the default master, if it does not.
    pub fn brace_problem(&self, b: &Brace) -> Option<String> {
        let def = self.design.default_master()?;
        let p = self.master_project(def);
        let reference = p.drawing(&b.of).ok()?;
        crate::compat::difference(reference, &b.contours)
    }

    /// Put brace layers into an instance at `loc`: each braced glyph is
    /// interpolated from the masters and its braces together.
    pub(crate) fn blend_braces(&self, p: &mut Project, layers: &[MasterLayer], loc: &[f64]) {
        let mut targets: Vec<&DrawingTarget> = Vec::new();
        for b in &self.design.braces {
            if !targets.contains(&&b.of) {
                targets.push(&b.of);
            }
        }
        let master_locs: Vec<Vec<f64>> =
            self.design.masters.iter().map(|m| self.design.master_location(m)).collect();
        for of in targets {
            let Some(sets): Option<Vec<(Vec<Contour>, f64)>> =
                layers.iter().map(|l| in_layer(l, of)).collect()
            else {
                continue;
            };
            let mut locs = master_locs.clone();
            let mut sets = sets;
            for b in self.braces_of(of) {
                locs.push(self.brace_location(b));
                sets.push((b.contours.clone(), b.advance_width));
            }
            if !sets.iter().all(|(c, _)| same_structure(c, &sets[0].0)) {
                continue;
            }
            let Ok(model) = Model::new(&locs) else { continue };
            let vals: Vec<Vec<f64>> = sets.iter().map(|(c, a)| flat(c, *a)).collect();
            let out = model.interpolate(&vals, loc);
            let mut contours = sets[0].0.clone();
            let mut i = 0;
            for c in &mut contours {
                for pt in &mut c.points {
                    pt.pos.x = out[i];
                    pt.pos.y = out[i + 1];
                    i += 2;
                }
            }
            let advance = out[i];
            match of {
                DrawingTarget::Base(id) => {
                    if let Some(b) = p.bases.get_mut(id) {
                        b.contours = contours;
                        b.advance_width = advance;
                    }
                }
                DrawingTarget::Symbol(id) => {
                    if let Some(s) = p.symbols.get_mut(id) {
                        s.contours = contours;
                        s.advance_width = advance;
                    }
                }
                _ => {}
            }
        }
    }
}
