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
    /// A verb that is recorded but not yet applied to outlines (bend).
    DeformNotApplied { alteration: AlterationId, verb: Verb },
    /// A deform found no stroke to work on: the base has none of its parts
    /// tagged and no upright stroke to fall back on.
    NoDeformTarget { alteration: AlterationId },
    /// A placed component that is not in the project.
    MissingComponent { component: String },
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
            for r in &base.components {
                match project.components.get(&r.component) {
                    Some(comp) => out.contours.extend(
                        r.place(comp)
                            .into_iter()
                            .map(|contour| ResolvedContour { source: Source::Component(r.id), contour }),
                    ),
                    None => {
                        out.diagnostics.push(Diagnostic::MissingComponent { component: r.component.clone() })
                    }
                }
            }
            base
        }
    };
    out.advance_width = base.advance_width;
    let family_base = project.bases.get(&family.base).expect("checked above");

    // Deforms first, so marks attach to the deformed strokes.
    let mut deformed = false;
    for alt_id in &alterations {
        let Some(alt) = project.alterations.get(alt_id) else { continue };
        if alt.verb.is_additive() {
            continue;
        }
        if apply_deform(&mut out, alt, family_base, &project.metrics) {
            deformed = true;
        }
    }
    let undeformed = base;
    let deformed_base;
    let base = if deformed {
        deformed_base =
            Base { contours: out.contours.iter().map(|c| c.contour.clone()).collect(), ..base.clone() };
        &deformed_base
    } else {
        base
    };

    for alt_id in &alterations {
        let Some(alt) = project.alterations.get(alt_id) else {
            out.diagnostics.push(Diagnostic::MissingAlteration { alteration: alt_id.clone() });
            continue;
        };
        if !alt.verb.is_additive() {
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
        let mut at = attach.at;
        if let Some(y) = alt.zone.as_deref().and_then(|z| project.metrics.zone_y(z)) {
            at.y = y;
        }
        let shift = at + project.attach_offset(family_id, alt_id) + placement_nudge(nudges, alt_id);
        for c in &alt.contours {
            let mut c = c.clone();
            c.translate(shift);
            out.contours.push(ResolvedContour { source: Source::Alteration(alt_id.clone()), contour: c });
        }
    }

    apply_point_nudges(&mut out, nudges, &alterations);

    // Grow the advance so added parts keep the base's right sidebearing.
    if let (Some(base_box), Some(all_box)) =
        (bounds_of(&undeformed.contours), bounds_of(out.contours.iter().map(|c| &c.contour)))
    {
        let rsb = undeformed.advance_width - base_box.max.x;
        out.advance_width = undeformed.advance_width.max(all_box.max.x + rsb);
    }

    Some(out)
}

/// Apply one deforming alteration to the base strokes in `out`. Returns
/// whether anything changed.
fn apply_deform(
    out: &mut ResolvedFidel,
    alt: &crate::alteration::Alteration,
    family_base: &Base,
    metrics: &crate::project::Metrics,
) -> bool {
    use crate::deform::{pick, warp_contour, warp_for};
    if alt.verb == Verb::Bend {
        out.diagnostics.push(Diagnostic::DeformNotApplied { alteration: alt.id.clone(), verb: alt.verb });
        return false;
    }
    let strokes: Vec<(usize, crate::geometry::Rect, Option<crate::parts::Part>)> = out
        .contours
        .iter()
        .enumerate()
        .filter(|(_, c)| c.source == Source::Base)
        .filter_map(|(i, c)| c.contour.bounds().map(|b| (i, b, c.contour.part)))
        .collect();
    // Unlike additive marks, a deform treats its parts as one set and lets the
    // region choose: "the stroke reaching lowest on the left" may be a leg in
    // one family and a stem in the next.
    let mut candidates: Vec<(usize, crate::geometry::Rect)> = strokes
        .iter()
        .filter(|(_, _, p)| p.is_some_and(|p| alt.placement.parts.contains(&p)))
        .map(|(i, b, _)| (*i, *b))
        .collect();
    if candidates.is_empty() {
        // Fall back to upright strokes.
        candidates = strokes
            .iter()
            .filter(|(_, b, _)| b.max.y - b.min.y > b.max.x - b.min.x)
            .map(|(i, b, _)| (*i, *b))
            .collect();
        if candidates.is_empty() {
            if !strokes.is_empty() {
                out.diagnostics.push(Diagnostic::NoDeformTarget { alteration: alt.id.clone() });
            }
            return false;
        }
        if !alt.placement.parts.is_empty() {
            let names: Vec<String> =
                alt.placement.parts.iter().map(|p| format!("{p:?}").to_lowercase()).collect();
            out.diagnostics.push(Diagnostic::PlacedByFallback {
                alteration: alt.id.clone(),
                reason: format!("no {} tagged on the base; used an upright stroke", names.join("/")),
            });
        }
    }
    let Some(i) = pick(&candidates, alt.placement.region) else { return false };
    let b = candidates.iter().find(|(j, _)| *j == i).map(|(_, b)| *b).expect("picked from candidates");
    let Some(warp) = warp_for(alt, b, metrics) else {
        out.diagnostics.push(Diagnostic::DeformNotApplied { alteration: alt.id.clone(), verb: alt.verb });
        return false;
    };
    let stroke_id = out.contours[i].contour.id;
    warp_contour(&mut out.contours[i].contour, &warp);
    // Components sitting on that stroke move with it.
    for r in family_base.components.iter().filter(|r| r.on == Some(stroke_id)) {
        let d = warp.apply(r.at) - r.at;
        for c in out.contours.iter_mut().filter(|c| c.source == Source::Component(r.id)) {
            c.contour.translate(d);
        }
    }
    true
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
