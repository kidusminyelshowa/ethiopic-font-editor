//! Turning a fidel recipe into outlines.

use serde::Serialize;

use crate::alteration::{AlterationId, Verb};
use crate::base::Base;
use crate::fidel::{FamilyId, FidelState, IrregularForm, Nudge, NudgeTarget, Source, StateKind};
use crate::geometry::{bounds_of, Contour, Vec2};
use crate::order::Order;
use crate::project::Project;

/// A contour in a resolved fidel, with where it came from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolvedContour {
    pub source: Source,
    pub contour: Contour,
}

/// Something the designer should know about a resolved fidel. None of these
/// stop resolution; they are shown next to the glyph.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum Diagnostic {
    /// The family's base is missing from the project.
    MissingBase,
    /// The base has no contours yet.
    BaseNotDrawn,
    /// The recipe names an alteration that does not exist.
    MissingAlteration { alteration: AlterationId },
    /// The alteration has no drawn parts yet.
    AlterationNotDrawn { alteration: AlterationId },
    /// Placement used a fallback, e.g. the base has no leg tagged.
    PlacedByFallback { alteration: AlterationId, reason: String },
    /// Deforming verbs (shorten, crick ...) are recorded but not yet applied
    /// to outlines.
    DeformNotApplied { alteration: AlterationId, verb: Verb },
    /// A nudge whose point no longer exists. It is kept, not dropped, so it
    /// comes back if the point does.
    OrphanedNudge { target: NudgeTarget },
    /// Irregular drawn fidel with no contours yet.
    NotYetDrawn,
    /// The fidel it is built on does not exist; built from the base instead.
    MissingBuiltOn { order: Order },
    /// "Built on" links that lead back to this fidel; built from the base
    /// instead.
    BuiltOnCycle { order: Order },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolvedFidel {
    pub family: FamilyId,
    pub order: Order,
    pub codepoint: Option<char>,
    pub state: StateKind,
    pub advance_width: f64,
    pub contours: Vec<ResolvedContour>,
    pub diagnostics: Vec<Diagnostic>,
}

impl ResolvedFidel {
    /// Contours that came from one source, e.g. a given alteration.
    pub fn from_source<'a>(&'a self, source: &'a Source) -> impl Iterator<Item = &'a Contour> + 'a {
        self.contours.iter().filter(move |c| &c.source == source).map(|c| &c.contour)
    }
}

pub(crate) fn resolve(project: &Project, family_id: &str, order: Order) -> Option<ResolvedFidel> {
    resolve_in_chain(project, family_id, order, &mut Vec::new())
}

/// `chain` holds the orders already being resolved below this one, to stop
/// "built on" loops.
fn resolve_in_chain(
    project: &Project,
    family_id: &str,
    order: Order,
    chain: &mut Vec<Order>,
) -> Option<ResolvedFidel> {
    let family = project.families.get(family_id)?;
    let fidel = family.fidels.get(&order)?;
    let base = project.bases.get(&family.base);

    let mut out = ResolvedFidel {
        family: family.id.clone(),
        order,
        codepoint: fidel.codepoint,
        state: fidel.state.kind(),
        advance_width: base.map(|b| b.advance_width).unwrap_or(0.0),
        contours: Vec::new(),
        diagnostics: Vec::new(),
    };

    let own = |contours: &[Contour]| {
        contours.iter().map(|c| ResolvedContour { source: Source::Own, contour: c.clone() }).collect()
    };

    match &fidel.state {
        FidelState::Detached { contours } => {
            out.contours = own(contours);
            return Some(out);
        }
        FidelState::Irregular { form: IrregularForm::Drawn { contours }, .. } => {
            if contours.is_empty() {
                out.diagnostics.push(Diagnostic::NotYetDrawn);
            }
            out.contours = own(contours);
            return Some(out);
        }
        _ => {}
    }

    let Some(base) = base else {
        out.diagnostics.push(Diagnostic::MissingBase);
        return Some(out);
    };
    if base.contours.is_empty() {
        out.diagnostics.push(Diagnostic::BaseNotDrawn);
    }

    let alterations = project.effective_alterations(family_id, order).unwrap_or_default();
    let nudges = fidel.state.nudges();

    // Start from the bare base, or from the fidel this one is built on. The
    // parent's outline then stands in for the base: alterations attach to it
    // and the advance grows from it.
    let parent = fidel.built_on.and_then(|parent| {
        if parent == order || chain.contains(&parent) {
            out.diagnostics.push(Diagnostic::BuiltOnCycle { order: parent });
            return None;
        }
        if !family.fidels.contains_key(&parent) {
            out.diagnostics.push(Diagnostic::MissingBuiltOn { order: parent });
            return None;
        }
        chain.push(order);
        let resolved = resolve_in_chain(project, family_id, parent, chain);
        chain.pop();
        resolved
    });
    let start_base;
    let base = match parent {
        Some(p) => {
            // A broken link further up still needs to be seen here.
            out.diagnostics.extend(p.diagnostics.into_iter().filter(|d| {
                matches!(d, Diagnostic::BuiltOnCycle { .. } | Diagnostic::MissingBuiltOn { .. })
            }));
            out.contours = p.contours;
            start_base = Base {
                contours: out.contours.iter().map(|c| c.contour.clone()).collect(),
                advance_width: p.advance_width,
                ..base.clone()
            };
            &start_base
        }
        None => {
            out.contours.extend(
                base.contours.iter().map(|c| ResolvedContour { source: Source::Base, contour: c.clone() }),
            );
            base
        }
    };
    out.advance_width = base.advance_width;

    for alt_id in &alterations {
        let Some(alt) = project.alterations.get(alt_id) else {
            out.diagnostics.push(Diagnostic::MissingAlteration { alteration: alt_id.clone() });
            continue;
        };
        if !alt.verb.is_additive() {
            out.diagnostics.push(Diagnostic::DeformNotApplied { alteration: alt_id.clone(), verb: alt.verb });
            continue;
        }
        if alt.contours.is_empty() {
            out.diagnostics.push(Diagnostic::AlterationNotDrawn { alteration: alt_id.clone() });
            continue;
        }
        let Some(attach) = alt.placement.attach_point(base) else {
            // Base not drawn: already reported.
            continue;
        };
        if let Some(reason) = attach.fallback {
            out.diagnostics.push(Diagnostic::PlacedByFallback { alteration: alt_id.clone(), reason });
        }
        let shift = attach.at + project.attach_offset(family_id, alt_id) + placement_nudge(nudges, alt_id);
        for c in &alt.contours {
            let mut c = c.clone();
            c.translate(shift);
            out.contours.push(ResolvedContour { source: Source::Alteration(alt_id.clone()), contour: c });
        }
    }

    apply_point_nudges(&mut out, nudges, &alterations);

    // Grow the advance so added parts keep the base's right sidebearing.
    if let (Some(base_box), Some(all_box)) =
        (bounds_of(&base.contours), bounds_of(out.contours.iter().map(|c| &c.contour)))
    {
        let rsb = base.advance_width - base_box.max.x;
        out.advance_width = base.advance_width.max(all_box.max.x + rsb);
    }

    Some(out)
}

fn placement_nudge(nudges: &[Nudge], alt: &str) -> Vec2 {
    nudges
        .iter()
        .filter(|n| matches!(&n.target, NudgeTarget::Placement { alteration } if alteration == alt))
        .fold(Vec2::ZERO, |acc, n| acc + n.delta)
}

fn apply_point_nudges(out: &mut ResolvedFidel, nudges: &[Nudge], alterations: &[AlterationId]) {
    for n in nudges {
        let found = match &n.target {
            NudgeTarget::Placement { alteration } => alterations.contains(alteration),
            NudgeTarget::Point { source, contour, point } => out
                .contours
                .iter_mut()
                .find(|c| &c.source == source && c.contour.id == *contour)
                .and_then(|c| c.contour.point_mut(*point))
                .map(|p| p.pos += n.delta)
                .is_some(),
        };
        if !found {
            out.diagnostics.push(Diagnostic::OrphanedNudge { target: n.target.clone() });
        }
    }
}
