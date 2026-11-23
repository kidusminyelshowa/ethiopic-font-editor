//! What the glyph editor reads and writes.

use fidel_core::{
    Alteration, Change, Contour, DrawingTarget, Effect, Metrics, ModelError, Order, Project, StateKind, Verb,
};
use serde::Serialize;

use crate::grid::Outline;

/// One drawing open in the editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawingView {
    target: DrawingTarget,
    title: String,
    subtitle: String,
    contours: Vec<Contour>,
    /// Set for bases. Alterations have no advance of their own.
    advance_width: Option<f64>,
    metrics: Metrics,
    /// For an alteration: a base drawn behind it, moved so that its attach
    /// point sits on the origin, so the part can be drawn in context.
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<ContextGhost>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextGhost {
    family: String,
    family_name: String,
    d: String,
}

impl DrawingView {
    pub fn open(
        project: &Project,
        target: DrawingTarget,
        context_family: Option<&str>,
    ) -> Result<Self, ModelError> {
        let contours = project.drawing(&target)?.to_vec();
        let metrics = project.metrics.clone();
        Ok(match &target {
            DrawingTarget::Base(id) => {
                let base = &project.bases[id];
                let glyph = project
                    .families
                    .values()
                    .find(|f| &f.base == id)
                    .and_then(|f| f.fidels.get(&Order::Giiz))
                    .and_then(|f| f.codepoint)
                    .map(String::from)
                    .unwrap_or_default();
                DrawingView {
                    title: format!("{} {glyph}", base.name).trim().to_string(),
                    subtitle: "Base · 1st order".into(),
                    advance_width: Some(base.advance_width),
                    context: None,
                    target,
                    contours,
                    metrics,
                }
            }
            DrawingTarget::Alteration(id) => {
                let alt = &project.alterations[id];
                DrawingView {
                    title: alt.name.clone(),
                    subtitle: "Alteration · drawn around its attach point".into(),
                    advance_width: None,
                    context: context_ghost(project, alt, context_family),
                    target,
                    contours,
                    metrics,
                }
            }
            DrawingTarget::Symbol(id) => {
                let sym = &project.symbols[id];
                DrawingView {
                    title: format!("{} {}", sym.name, sym.codepoint),
                    subtitle: format!("Symbol · U+{:04X}", sym.codepoint as u32),
                    advance_width: Some(sym.advance_width),
                    context: None,
                    target,
                    contours,
                    metrics,
                }
            }
        })
    }
}

/// The base of `family` (or the first family with a drawn base) moved so the
/// alteration's attach point is at the origin.
fn context_ghost(project: &Project, alt: &Alteration, family: Option<&str>) -> Option<ContextGhost> {
    let mut families: Vec<_> = project.families.values().collect();
    families.sort_by_key(|f| f.fidels.get(&Order::Giiz).and_then(|g| g.codepoint));
    let fam = match family {
        Some(id) => project.families.get(id)?,
        None => {
            *families.iter().find(|f| project.bases.get(&f.base).is_some_and(|b| !b.contours.is_empty()))?
        }
    };
    let base = project.bases.get(&fam.base)?;
    let at = alt.placement.attach_point(base)?.at;
    let moved: Vec<Contour> = base
        .contours
        .iter()
        .map(|c| {
            let mut c = c.clone();
            c.translate(fidel_core::Vec2::new(-at.x, -at.y));
            c
        })
        .collect();
    Some(ContextGhost {
        family: fam.id.clone(),
        family_name: fam.name.clone(),
        d: fidel_core::svg_path(&moved),
    })
}

/// An alteration the editor can open.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterationSummary {
    id: String,
    name: String,
    verb: Verb,
    /// Only additive alterations have parts to draw.
    drawable: bool,
    drawn: bool,
    /// Orders with at least one fidel built from this alteration.
    orders: Vec<Order>,
    /// How many fidel are built from it.
    users: usize,
    /// For a copy made by a scoped edit: the shared alteration it came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    forked_from: Option<String>,
}

pub fn alteration_summaries(project: &Project) -> Vec<AlterationSummary> {
    project
        .alterations
        .values()
        .map(|a| AlterationSummary {
            id: a.id.clone(),
            name: a.name.clone(),
            verb: a.verb,
            drawable: a.verb.is_additive(),
            drawn: !a.contours.is_empty(),
            orders: {
                let users = project.users_of(&a.id);
                let mut orders: Vec<Order> = users.iter().map(|(_, o)| *o).collect();
                orders.sort();
                orders.dedup();
                if orders.is_empty() {
                    // Not used yet: fall back to the rule that names it.
                    orders = project
                        .order_rules
                        .values()
                        .filter(|r| r.variants.iter().any(|v| v.contains(&a.id)))
                        .map(|r| r.order)
                        .collect();
                }
                orders
            },
            users: project.users_of(&a.id).len(),
            forked_from: a.forked_from.clone(),
        })
        .collect()
}

/// One fidel an alteration edit reaches, for the "where this applies" panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactView {
    family: String,
    family_name: String,
    order: Order,
    codepoint: Option<char>,
    state: StateKind,
    effect: Effect,
}

/// In Unicode order, which is the traditional fidel order.
pub fn alteration_impacts(project: &Project, id: &str) -> Vec<ImpactView> {
    let mut out: Vec<ImpactView> = project
        .impacts(&Change::Alteration(id.to_string()))
        .into_iter()
        .map(|i| ImpactView {
            family_name: project.families.get(&i.family).map(|f| f.name.clone()).unwrap_or_default(),
            codepoint: project.fidel(&i.family, i.order).ok().and_then(|f| f.codepoint),
            family: i.family,
            order: i.order,
            state: i.state,
            effect: i.effect,
        })
        .collect();
    out.sort_by_key(|i| (i.codepoint, i.order));
    out
}

/// One family resolved across its orders, for the editor's live preview strip.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelPreview {
    order: Order,
    order_name: &'static str,
    codepoint: Option<char>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outline: Option<Outline>,
    /// Short notes such as "loop not drawn yet".
    issues: Vec<String>,
}

pub fn family_preview(project: &Project, family: &str) -> Result<Vec<FidelPreview>, ModelError> {
    let fam = project.families.get(family).ok_or_else(|| ModelError::UnknownFamily(family.into()))?;
    Order::ALL
        .iter()
        .chain(Order::EXTRA.iter())
        .filter(|o| fam.fidels.contains_key(o) && project.fidel_in_charset(family, **o))
        .map(|&order| {
            let r = project.resolve(family, order)?;
            let issues = r.diagnostics.iter().map(describe).collect();
            Ok(FidelPreview {
                order,
                order_name: order.name(),
                codepoint: r.codepoint,
                outline: Outline::of(project, family, order),
                issues,
            })
        })
        .collect()
}

fn describe(d: &fidel_core::Diagnostic) -> String {
    use fidel_core::Diagnostic::*;
    match d {
        MissingBase => "base missing".into(),
        BaseNotDrawn => "base not drawn yet".into(),
        MissingAlteration { alteration } => format!("{alteration} missing"),
        AlterationNotDrawn { alteration } => format!("{alteration} not drawn yet"),
        PlacedByFallback { reason, .. } => reason.clone(),
        DeformNotApplied { verb, .. } => format!("{verb:?} not applied yet").to_lowercase(),
        OrphanedNudge { .. } => "a nudge lost its point".into(),
        NotYetDrawn => "not drawn yet".into(),
        MissingBuiltOn { order } => format!("built on {}, which is missing", order.name()),
        BuiltOnCycle { order } => format!("built-on links loop through {}", order.name()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fidel_core::{defaults::geez_project, Part, Vec2};

    fn drawn_project() -> Project {
        let mut p = geez_project(Metrics::default());
        p.set_drawing(
            &DrawingTarget::Base("la".into()),
            vec![
                Contour::rect(0, Some(Part::Stem), Vec2::new(50.0, 0.0), Vec2::new(110.0, 700.0)),
                Contour::rect(1, Some(Part::Leg), Vec2::new(400.0, 0.0), Vec2::new(460.0, 640.0)),
            ],
        )
        .unwrap();
        p
    }

    #[test]
    fn alteration_opens_with_a_context_base_at_the_origin() {
        let p = drawn_project();
        let v = DrawingView::open(&p, DrawingTarget::Alteration("loop.bottom-right".into()), None).unwrap();
        let ghost = v.context.expect("context base");
        assert_eq!(ghost.family, "la");
        // The leg's bottom middle (430, 0) is moved to the origin.
        assert!(ghost.d.contains("M-30 0L30 0"), "{}", ghost.d);
        assert_eq!(v.advance_width, None);
    }

    #[test]
    fn base_opens_with_its_advance() {
        let p = drawn_project();
        let v = DrawingView::open(&p, DrawingTarget::Base("la".into()), None).unwrap();
        assert_eq!(v.title, "Lawi ለ");
        assert_eq!(v.contours.len(), 2);
        assert_eq!(v.advance_width, Some(600.0));
    }

    #[test]
    fn preview_reports_what_is_missing() {
        let p = drawn_project();
        let prev = family_preview(&p, "la").unwrap();
        assert_eq!(prev.len(), 7);
        assert!(prev[0].outline.is_some());
        assert!(prev[4].issues.iter().any(|i| i.contains("loop.bottom-right not drawn")));
        assert!(prev[5].issues.iter().any(|i| i == "crick not applied yet"));
    }

    #[test]
    fn only_additive_alterations_are_drawable() {
        let p = geez_project(Metrics::default());
        let list = alteration_summaries(&p);
        assert!(list.iter().find(|a| a.id == "loop.bottom-right").unwrap().drawable);
        assert!(!list.iter().find(|a| a.id == "crick.first-stroke").unwrap().drawable);
        assert_eq!(list.iter().find(|a| a.id == "loop.bottom-right").unwrap().orders, vec![Order::Hamis]);
    }
}
