//! What the glyph editor reads and writes.

use fidel_core::{
    Alteration, Change, ComponentKind, ComponentRef, Contour, DrawingTarget, Effect, Metrics, ModelError,
    Order, Project, StateKind, Vec2, Verb,
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
    /// For an alteration: a base drawn behind it in its own coordinates, so
    /// the part is drawn in the same space as the base.
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<ContextGhost>,
    /// Pa-height zones, in font units.
    zones: Vec<ZoneView>,
    /// For a base: the components placed on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    components: Option<Vec<PlacedComponent>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneView {
    id: String,
    name: String,
    position: f64,
    size: f64,
}

pub fn zone_views(metrics: &Metrics) -> Vec<ZoneView> {
    let h = metrics.pa_height();
    metrics
        .zones()
        .into_iter()
        .map(|z| ZoneView {
            position: metrics.pa_bottom + z.at * h,
            size: z.size * h,
            id: z.id,
            name: z.name,
        })
        .collect()
}

/// A component placed on a base, with its outline in base coordinates.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedComponent {
    placement: ComponentRef,
    name: String,
    kind: Option<ComponentKind>,
    d: String,
}

fn placed_components(project: &Project, base: &str) -> Vec<PlacedComponent> {
    project.bases[base]
        .components
        .iter()
        .map(|r| {
            let comp = project.components.get(&r.component);
            PlacedComponent {
                name: comp.map_or_else(|| r.component.clone(), |c| c.name.clone()),
                kind: comp.map(|c| c.kind),
                d: comp.map(|c| fidel_core::svg_path(&r.place(c))).unwrap_or_default(),
                placement: r.clone(),
            }
        })
        .collect()
}

/// A component the editor can open or place.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSummary {
    id: String,
    name: String,
    kind: ComponentKind,
    drawn: bool,
    /// How many bases place it.
    uses: usize,
}

pub fn component_summaries(project: &Project) -> Vec<ComponentSummary> {
    project
        .components
        .values()
        .map(|c| ComponentSummary {
            id: c.id.clone(),
            name: c.name.clone(),
            kind: c.kind,
            drawn: !c.contours.is_empty(),
            uses: project.bases.values().filter(|b| b.components.iter().any(|r| r.component == c.id)).count(),
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextGhost {
    family: String,
    family_name: String,
    d: String,
    /// The base's advance, so the canvas frames it like the base itself.
    advance_width: f64,
    /// Where the alteration attaches on this family: the automatic point
    /// plus the family's offset. The alteration's contours are shown and
    /// edited relative to it.
    origin: Vec2,
    /// The automatic point alone; the family's offset is origin minus this.
    auto_origin: Vec2,
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
                    components: Some(placed_components(project, id)),
                    zones: zone_views(&metrics),
                    target,
                    contours,
                    metrics,
                }
            }
            DrawingTarget::Alteration(id) => {
                let alt = &project.alterations[id];
                DrawingView {
                    title: alt.name.clone(),
                    subtitle: "Alteration".into(),
                    advance_width: None,
                    context: context_ghost(project, alt, context_family),
                    components: None,
                    zones: zone_views(&metrics),
                    target,
                    contours,
                    metrics,
                }
            }
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id)?;
                let r = project.resolve(&family, order)?;
                let fam = &project.families[&family];
                DrawingView {
                    title: format!("{} {}", fam.name, r.codepoint.map(String::from).unwrap_or_default())
                        .trim()
                        .to_string(),
                    subtitle: format!("{} · drawn by hand", order.name()),
                    advance_width: None,
                    context: None,
                    components: None,
                    zones: zone_views(&metrics),
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
                    components: None,
                    zones: zone_views(&metrics),
                    target,
                    contours,
                    metrics,
                }
            }
            DrawingTarget::Component(id) => {
                let comp = &project.components[id];
                let kind = match comp.kind {
                    ComponentKind::Leaf => "Leaf",
                    ComponentKind::Cap => "Cap",
                    ComponentKind::Corner => "Corner",
                };
                DrawingView {
                    title: comp.name.clone(),
                    subtitle: format!("{kind} component"),
                    advance_width: None,
                    context: None,
                    components: None,
                    zones: zone_views(&metrics),
                    target,
                    contours,
                    metrics,
                }
            }
        })
    }
}

/// The base of `family` (or the first family with a drawn base), with where
/// the alteration attaches on it.
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
    let auto_origin = alt.placement.attach_point(base)?.at;
    Some(ContextGhost {
        family: fam.id.clone(),
        family_name: fam.name.clone(),
        d: fidel_core::svg_path(&base.contours),
        advance_width: base.advance_width,
        origin: auto_origin + project.attach_offset(&fam.id, &alt.id),
        auto_origin,
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
    /// For deforms: the zone it lands on and how far it pulls.
    #[serde(skip_serializing_if = "Option::is_none")]
    zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount: Option<f64>,
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
            zone: a.zone.clone(),
            amount: a.amount,
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
        NoDeformTarget { .. } => "no stroke to deform; tag the base's legs".into(),
        MissingComponent { component } => format!("component {component} missing"),
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
    fn alteration_opens_in_the_base_space() {
        let mut p = drawn_project();
        let v = DrawingView::open(&p, DrawingTarget::Alteration("loop.bottom-right".into()), None).unwrap();
        let ghost = v.context.expect("context base");
        assert_eq!(ghost.family, "la");
        // The base is not moved; the leg's bottom middle is the attach point.
        assert!(ghost.d.contains("M400 0L460 0"), "{}", ghost.d);
        assert_eq!(ghost.origin, Vec2::new(430.0, 0.0));
        assert_eq!(v.advance_width, None);

        p.set_attach_offset("la", "loop.bottom-right", Vec2::new(10.0, -20.0)).unwrap();
        let v =
            DrawingView::open(&p, DrawingTarget::Alteration("loop.bottom-right".into()), Some("la")).unwrap();
        let ghost = v.context.unwrap();
        assert_eq!(ghost.origin, Vec2::new(440.0, -20.0));
        assert_eq!(ghost.auto_origin, Vec2::new(430.0, 0.0));
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
        // The crick is applied now, so ሳድስ has nothing to report.
        assert!(prev[5].issues.is_empty(), "{:?}", prev[5].issues);
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
