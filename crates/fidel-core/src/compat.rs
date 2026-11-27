//! Making a drawing's masters match: contour order, direction and start
//! points, and a plain account of what still differs.

use serde::Serialize;

use crate::compat_points::{add_points_to_match, start_near};
use crate::component::reverse;
use crate::geometry::{Contour, PointKind, Vec2};
use crate::project::{DrawingTarget, ModelError, Project};

/// Twice the signed area: positive counter-clockwise.
fn area(c: &Contour) -> f64 {
    let n = c.points.len();
    (0..n)
        .map(|i| {
            let (a, b) = (c.points[i].pos, c.points[(i + 1) % n].pos);
            a.x * b.y - b.x * a.y
        })
        .sum()
}

fn center(c: &Contour) -> Vec2 {
    c.bounds().map(|r| r.center()).unwrap_or_default()
}

fn len(v: Vec2) -> f64 {
    v.x.hypot(v.y)
}

fn kinds(c: &Contour) -> Vec<PointKind> {
    c.points.iter().map(|p| p.kind).collect()
}

/// `other` reordered, turned and restarted to line up with `reference`:
/// each contour pairs with the one of the same size nearest it, runs the
/// same way, and starts at the point that matches the reference's start.
pub fn match_contours(reference: &[Contour], other: &[Contour]) -> Vec<Contour> {
    let mut left: Vec<Contour> = other.to_vec();
    let mut out = Vec::with_capacity(other.len());
    for r in reference {
        if left.is_empty() {
            break;
        }
        let rc = center(r);
        let pick = (0..left.len())
            .min_by(|&a, &b| {
                let score = |i: usize| {
                    let same = left[i].points.len() == r.points.len();
                    ((!same) as u8, len(center(&left[i]) - rc))
                };
                let (sa, da) = score(a);
                let (sb, db) = score(b);
                sa.cmp(&sb).then(da.total_cmp(&db))
            })
            .unwrap();
        let mut c = left.remove(pick);
        if area(&c).signum() != area(r).signum() && !c.open {
            reverse(&mut c);
        }
        restart(r, &mut c);
        out.push(c);
    }
    out.extend(left);
    out
}

/// Rotate a closed contour so its point types line up with the reference's
/// and its start is the one nearest the reference's start (relative to each
/// contour's middle).
fn restart(reference: &Contour, c: &mut Contour) {
    let n = c.points.len();
    if c.open || n != reference.points.len() || n == 0 {
        return;
    }
    let want = kinds(reference);
    let (rc, cc) = (center(reference), center(c));
    let rs = reference.points[0].pos - rc;
    let best = (0..n).filter(|&k| (0..n).all(|i| c.points[(k + i) % n].kind == want[i])).min_by(|&a, &b| {
        let d = |k: usize| len((c.points[k].pos - cc) - rs);
        d(a).total_cmp(&d(b))
    });
    if let Some(k) = best {
        c.points.rotate_left(k);
    }
}

/// What keeps two versions of a drawing from interpolating, in words; None
/// when they match point for point.
pub fn difference(reference: &[Contour], other: &[Contour]) -> Option<String> {
    if reference.len() != other.len() {
        return Some(format!("{} contours, the default master has {}", other.len(), reference.len()));
    }
    for (i, (r, c)) in reference.iter().zip(other).enumerate() {
        if r.points.len() != c.points.len() {
            return Some(format!(
                "Contour {} has {} points, the default master {}",
                i + 1,
                c.points.len(),
                r.points.len()
            ));
        }
        if r.open != c.open {
            return Some(format!("Contour {} is open in one master only", i + 1));
        }
        if kinds(r) != kinds(c) {
            return Some(format!("Contour {} has its point types in another order", i + 1));
        }
    }
    None
}

/// One master's version of a drawing, for the side-by-side view.
#[derive(Debug, Clone, Serialize)]
pub struct MasterDrawing {
    pub master: String,
    pub contours: Vec<Contour>,
    pub advance: Option<f64>,
    /// Why it does not interpolate with the default master.
    pub problem: Option<String>,
    pub is_default: bool,
    /// Set for a brace layer: its id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brace: Option<String>,
}

impl Project {
    /// The drawing in every master.
    pub fn master_drawings(&self, target: &DrawingTarget) -> Result<Vec<MasterDrawing>, ModelError> {
        // A brace layer is shown with the glyph it belongs to.
        let target = &match target {
            DrawingTarget::Brace(id) => self.brace(id)?.of.clone(),
            t => t.clone(),
        };
        let def = self.design.default_master().unwrap_or(self.design.active);
        let projects: Vec<Project> = if self.design.masters.len() < 2 {
            vec![self.clone()]
        } else {
            (0..self.design.masters.len()).map(|i| self.master_project(i)).collect()
        };
        let reference = projects.get(def).unwrap_or(&projects[0]).drawing(target)?.to_vec();
        projects
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let contours = p.drawing(target)?.to_vec();
                let advance = match target {
                    DrawingTarget::Base(id) => p.bases.get(id).map(|b| b.advance_width),
                    DrawingTarget::Symbol(id) => p.symbols.get(id).map(|s| s.advance_width),
                    _ => None,
                };
                Ok(MasterDrawing {
                    brace: None,
                    master: self
                        .design
                        .masters
                        .get(i)
                        .map(|m| m.name.clone())
                        .unwrap_or_else(|| "Regular".into()),
                    problem: if i == def { None } else { difference(&reference, &contours) },
                    contours,
                    advance,
                    is_default: i == def,
                })
            })
            .collect::<Result<Vec<_>, ModelError>>()
            .map(|mut list| {
                let name = |b: &crate::braces::Brace| {
                    let at: Vec<String> = self
                        .design
                        .axes
                        .iter()
                        .map(|a| format!("{}", b.location.get(&a.tag).copied().unwrap_or(a.default).round()))
                        .collect();
                    format!("{{{}}}", at.join(", "))
                };
                for b in self.braces_of(target) {
                    list.push(MasterDrawing {
                        master: name(b),
                        contours: b.contours.clone(),
                        advance: Some(b.advance_width),
                        problem: difference(&reference, &b.contours),
                        is_default: false,
                        brace: Some(b.id.clone()),
                    });
                }
                list
            })
    }

    /// Line up every master's version of a drawing with the default
    /// master's: contour order, direction and start points, and points
    /// added where one has a point the other lacks. Returns how many masters
    /// changed.
    pub fn match_masters(&mut self, target: &DrawingTarget) -> Result<usize, ModelError> {
        if self.design.masters.len() < 2 {
            return Ok(0);
        }
        let def = self.design.default_master().unwrap_or(0);
        let back = self.design.active;
        let differs = |a: &Contour, b: &Contour| a.open != b.open || kinds(a) != kinds(b);
        let mut changed = std::collections::BTreeSet::new();
        // Adding points to the default master undoes the masters matched
        // before it, so go round again until nothing needs points.
        for _ in 0..=self.design.masters.len() {
            let _ = self.switch_master(def);
            let mut reference = self.drawing(target)?.to_vec();
            let mut grown = false;
            for m in 0..self.design.masters.len() {
                if m == def {
                    continue;
                }
                let _ = self.switch_master(m);
                let now = self.drawing(target)?.to_vec();
                let mut fixed = match_contours(&reference, &now);
                for (r, c) in reference.iter_mut().zip(fixed.iter_mut()) {
                    if !differs(r, c) {
                        continue;
                    }
                    if let Some(p) = r.points.iter().find(|p| p.is_on_curve()) {
                        start_near(c, p.pos, center(r));
                    }
                    if let Some((nr, nc)) = add_points_to_match(r, c) {
                        if nr != *r {
                            *r = nr;
                            grown = true;
                        }
                        *c = nc;
                    }
                    restart(r, c);
                }
                if fixed != now {
                    self.set_drawing(target, fixed)?;
                    changed.insert(m);
                }
            }
            if !grown {
                break;
            }
            let _ = self.switch_master(def);
            self.set_drawing(target, reference)?;
            changed.insert(def);
        }
        let _ = self.switch_master(back);
        Ok(changed.len())
    }
}
