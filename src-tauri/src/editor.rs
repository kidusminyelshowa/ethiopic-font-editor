//! What the glyph editor reads and writes.

use fidel_core::{
    Alteration, Change, ComponentKind, ComponentRef, Contour, CornerSide, DeformHandle, DrawingTarget,
    Effect, FidelState, Metrics, ModelError, Order, Part, Project, StateKind, Tweak, Vec2, Verb,
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
    /// A generated fidel opened in place: points can be moved (they become
    /// nudges) but not added or removed.
    generated: bool,
    /// For a generated fidel: the ends of its deformed strokes, to drag.
    handles: Vec<DeformHandle>,
    /// For a component: where it lands by rule.
    #[serde(skip_serializing_if = "Option::is_none")]
    rule: Option<ComponentRule>,
    /// For a base made from another row's base (ሸ from ሰ).
    #[serde(skip_serializing_if = "Option::is_none")]
    derived: Option<DerivedView>,
    /// For bases and symbols: sidebearings and width set by other glyphs,
    /// with why a key does not apply.
    #[serde(skip_serializing_if = "Option::is_none")]
    metric_keys: Option<KeysView>,
    /// For bases and symbols: where accents attach (`top`) or where this
    /// accent joins (`_top`).
    #[serde(skip_serializing_if = "Option::is_none")]
    anchors: Option<std::collections::BTreeMap<String, Vec2>>,
    /// For a letter built from parts: the parts, and the built outline.
    #[serde(skip_serializing_if = "Option::is_none")]
    built: Option<BuiltView>,
}

#[derive(Debug, Serialize)]
pub struct BuiltView {
    /// The base letter, then its accents.
    parts: Vec<char>,
    /// The built outline, as an SVG path.
    d: String,
    /// Left and right edges of the built outline, when it has ink.
    ink: Option<[f64; 2]>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysView {
    keys: fidel_core::metric_keys::MetricKeys,
    /// By side (`left`, `right`, `width`).
    errors: std::collections::BTreeMap<&'static str, String>,
}

fn keys_view(project: &Project, keys: &fidel_core::metric_keys::MetricKeys) -> KeysView {
    use fidel_core::metric_keys::Side;
    let mut errors = std::collections::BTreeMap::new();
    for (name, side, key) in [
        ("left", Side::Left, &keys.left),
        ("right", Side::Right, &keys.right),
        ("width", Side::Width, &keys.width),
    ] {
        if let Some(k) = key.as_deref().filter(|k| !k.trim().is_empty()) {
            if let Err(e) = project.evaluate_key(k, side) {
                errors.insert(name, e);
            }
        }
    }
    KeysView { keys: keys.clone(), errors }
}

/// Where a derived base comes from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedView {
    from: String,
    from_name: String,
    from_glyph: String,
    /// The added marks, by id and name.
    adds: Vec<(String, String)>,
    follows: bool,
}

/// The 1st-order fidel of the family drawn from a base, for labels.
fn base_glyph(project: &Project, base: &str) -> String {
    project
        .families
        .values()
        .filter(|f| f.base == base)
        .filter_map(|f| f.fidels.get(&Order::Giiz).and_then(|g| g.codepoint))
        .min()
        .map(String::from)
        .unwrap_or_default()
}

/// Where a component lands by rule, and how often it does.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentRule {
    lands_on: Vec<Part>,
    corners: CornerSide,
    /// Placements across all bases.
    uses: usize,
}

/// One place a component lands by rule on a base.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleEnd {
    component: String,
    name: String,
    kind: ComponentKind,
    key: String,
    /// "Bar · Right end".
    label: String,
    on: bool,
    tweak: Tweak,
    /// Placed outline, in base coordinates.
    d: String,
}

pub fn rule_ends(project: &Project, base: &str) -> Vec<RuleEnd> {
    let Some(b) = project.bases.get(base) else { return Vec::new() };
    project
        .rule_ends(base)
        .into_iter()
        .map(|(comp, e)| {
            let contour = e.placement.on.and_then(|id| b.contours.iter().find(|c| c.id == id));
            let what = contour
                .and_then(|c| c.name.clone().or_else(|| c.part.map(|p| capitalise(&format!("{p:?}")))))
                .unwrap_or_else(|| "Path".into());
            RuleEnd {
                component: comp.id.clone(),
                name: comp.name.clone(),
                kind: comp.kind,
                label: format!("{what} · {}", e.label),
                on: e.on,
                tweak: comp.tweaks.get(&e.key).cloned().unwrap_or_default(),
                d: fidel_core::svg_path(&e.placement.place_in(comp, &project.design.font_location())),
                key: e.key,
            }
        })
        .collect()
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c.flat_map(char::to_lowercase)).collect()).unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneView {
    id: String,
    name: String,
    position: f64,
    size: f64,
}

/// The name of the form a family uses for an order ("Short left leg").
pub fn form_name(project: &Project, family: &str, order: Order) -> String {
    let v = project.families.get(family).and_then(|f| f.rule_variants.get(&order).copied()).unwrap_or(0);
    project.order_rules.get(&order).and_then(|r| r.name(v)).unwrap_or("Generated").to_string()
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

fn placed_components(project: &Project, refs: &[ComponentRef]) -> Vec<PlacedComponent> {
    refs.iter()
        .map(|r| {
            let comp = project.components.get(&r.component);
            PlacedComponent {
                name: comp.map_or_else(|| r.component.clone(), |c| c.name.clone()),
                kind: comp.map(|c| c.kind),
                d: comp
                    .map(|c| fidel_core::svg_path(&r.place_in(c, &project.design.font_location())))
                    .unwrap_or_default(),
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
    /// Its own axes, for setting each placement.
    axes: Vec<fidel_core::PartAxis>,
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
            axes: c.axes.clone(),
            uses: project.bases.values().filter(|b| b.components.iter().any(|r| r.component == c.id)).count()
                + project
                    .symbols
                    .values()
                    .filter(|s| s.components.iter().any(|r| r.component == c.id))
                    .count(),
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
    /// The whole outline as one SVG path: the contours, placed parts, and a
    /// built letter's outline when nothing is drawn over it.
    pub fn outline_d(&self) -> String {
        let mut d = fidel_core::svg_path(&self.contours);
        for c in self.components.iter().flatten() {
            d.push_str(&c.d);
        }
        if self.contours.is_empty() {
            if let Some(b) = &self.built {
                d.push_str(&b.d);
            }
        }
        d
    }

    pub fn open(
        project: &Project,
        target: DrawingTarget,
        context_family: Option<&str>,
    ) -> Result<Self, ModelError> {
        let mut generated = false;
        let contours = match &target {
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id)?;
                match &project.fidel(&family, order)?.state {
                    // Drawn by hand.
                    FidelState::Detached { contours } if !contours.is_empty() => contours.clone(),
                    // "Draw it" with nothing drawn yet: start from what it
                    // generates.
                    FidelState::Detached { .. } => {
                        let mut copy = project.clone();
                        copy.detach(&family, order)?;
                        copy.drawing(&target)?.to_vec()
                    }
                    // Generated: edited in place, moved points become nudges.
                    _ => {
                        generated = true;
                        project.generated_outline(&family, order)?
                    }
                }
            }
            _ => project.drawing(&target)?.to_vec(),
        };
        let metrics = project.metrics.clone();
        let anchors = match &target {
            DrawingTarget::Base(id) => project.bases.get(id).map(|b| b.anchors.clone()),
            DrawingTarget::Symbol(id) => project.symbols.get(id).map(|s| s.anchors.clone()),
            DrawingTarget::Fidel(id) => {
                let (family, order) = DrawingTarget::fidel_ref(id)?;
                project.families.get(&family).map(|f| project.fidel_anchors(f, order))
            }
            _ => None,
        };
        let built = match &target {
            DrawingTarget::Symbol(id) => {
                project.symbols.get(id).filter(|s| !s.built_from.is_empty()).map(|s| {
                    let outline = project.symbol_outline(id);
                    let upright = fidel_core::metric_keys::upright(&outline, project.metrics.italic_angle);
                    let ink = fidel_core::geometry::bounds_of(&upright).map(|r| [r.min.x, r.max.x]);
                    BuiltView { parts: s.built_from.clone(), d: fidel_core::svg_path(&outline), ink }
                })
            }
            _ => None,
        };
        let mut view = match &target {
            DrawingTarget::Base(id) => {
                let base = &project.bases[id];
                let glyph = base_glyph(project, id);
                let derived = base.derived.as_ref().map(|d| DerivedView {
                    from_name: project.bases.get(&d.from).map(|b| b.name.clone()).unwrap_or_default(),
                    from_glyph: base_glyph(project, &d.from),
                    adds: d
                        .adds
                        .iter()
                        .map(|a| {
                            (
                                a.clone(),
                                project.alterations.get(a).map(|x| x.name.clone()).unwrap_or_default(),
                            )
                        })
                        .collect(),
                    follows: !d.own,
                    from: d.from.clone(),
                });
                let subtitle = match &derived {
                    Some(d) if d.follows => format!("Base · from {} {}", d.from_name, d.from_glyph),
                    Some(_) => "Base · drawn by hand".into(),
                    None => "Base · 1st order".into(),
                };
                DrawingView {
                    title: format!("{} {glyph}", base.name).trim().to_string(),
                    subtitle: subtitle.trim().to_string(),
                    derived,
                    metric_keys: Some(keys_view(project, &base.metric_keys)),
                    advance_width: Some(base.advance_width),
                    context: None,
                    components: Some(placed_components(project, &base.components)),
                    zones: zone_views(&metrics),
                    generated: false,
                    handles: Vec::new(),
                    rule: None,
                    anchors: None,
                    built: None,
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
                    generated: false,
                    handles: Vec::new(),
                    rule: None,
                    derived: None,
                    metric_keys: None,
                    anchors: None,
                    built: None,
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
                    subtitle: if generated {
                        format!("{} · {}", order.name(), form_name(project, &family, order))
                    } else {
                        format!("{} · drawn by hand", order.name())
                    },
                    advance_width: None,
                    context: None,
                    components: Some(placed_components(project, &project.fidel(&family, order)?.components)),
                    zones: zone_views(&metrics),
                    generated,
                    handles: if generated { r.handles.clone() } else { Vec::new() },
                    rule: None,
                    derived: None,
                    metric_keys: None,
                    anchors: None,
                    built: None,
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
                    advance_width: Some(project.symbol_advance(id)),
                    context: None,
                    components: Some(placed_components(project, &sym.components)),
                    zones: zone_views(&metrics),
                    generated: false,
                    handles: Vec::new(),
                    rule: None,
                    derived: None,
                    metric_keys: Some(keys_view(project, &sym.metric_keys)),
                    anchors: None,
                    built: None,
                    target,
                    contours,
                    metrics,
                }
            }
            DrawingTarget::Brace(id) => {
                let b = project.brace(id)?;
                let name = match &b.of {
                    DrawingTarget::Base(base) => {
                        format!("{} {}", project.bases[base].name, base_glyph(project, base))
                            .trim()
                            .to_string()
                    }
                    DrawingTarget::Symbol(sym) => project
                        .symbols
                        .get(sym)
                        .map(|s| format!("{} {}", s.name, s.codepoint))
                        .unwrap_or_default(),
                    _ => String::new(),
                };
                let at: Vec<String> = project
                    .design
                    .axes
                    .iter()
                    .map(|a| {
                        format!("{} {}", a.name, b.location.get(&a.tag).copied().unwrap_or(a.default).round())
                    })
                    .collect();
                DrawingView {
                    title: name,
                    subtitle: format!("Brace layer · {}", at.join(", ")),
                    advance_width: Some(b.advance_width),
                    context: None,
                    components: None,
                    zones: zone_views(&metrics),
                    generated: false,
                    handles: Vec::new(),
                    rule: None,
                    derived: None,
                    metric_keys: None,
                    anchors: None,
                    built: None,
                    target,
                    contours,
                    metrics,
                }
            }
            DrawingTarget::Component(full) => {
                let (id, state) = fidel_core::parametric::state_ref(full);
                let id = &id.to_string();
                let comp = &project.components[id];
                let kind = match comp.kind {
                    ComponentKind::Leaf => "Leaf",
                    ComponentKind::Cap => "Cap",
                    ComponentKind::Corner => "Corner",
                };
                let subtitle = match state {
                    None if comp.states.is_empty() => format!("{kind} component"),
                    None => format!("{kind} component · Default state"),
                    Some(i) => format!("{kind} component · State {}", i + 1),
                };
                DrawingView {
                    title: comp.name.clone(),
                    subtitle,
                    advance_width: None,
                    context: None,
                    components: None,
                    zones: zone_views(&metrics),
                    generated: false,
                    handles: Vec::new(),
                    derived: None,
                    metric_keys: None,
                    rule: Some(ComponentRule {
                        lands_on: comp.lands_on.clone(),
                        corners: comp.corners,
                        uses: project.rule_uses(id),
                    }),
                    anchors: None,
                    built: None,
                    target,
                    contours,
                    metrics,
                }
            }
        };
        view.anchors = anchors;
        view.built = built;
        Ok(view)
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
    impacts_of(project, &Change::Alteration(id.to_string()))
}

/// The fidel an edit to a base reaches, in Unicode order.
pub fn base_impacts(project: &Project, id: &str) -> Vec<ImpactView> {
    impacts_of(project, &Change::Base(id.to_string()))
}

fn impacts_of(project: &Project, change: &Change) -> Vec<ImpactView> {
    let mut out: Vec<ImpactView> = project
        .impacts(change)
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
        // ል takes the ring at the foot, which is not drawn yet.
        assert_eq!(prev[5].issues, vec!["loop.bottom-left not drawn yet".to_string()]);
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

/// One master's version of a drawing, for the side-by-side view.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterDrawingView {
    master: String,
    d: String,
    advance: Option<f64>,
    problem: Option<String>,
    is_default: bool,
    contours: Vec<fidel_core::Contour>,
    #[serde(skip_serializing_if = "Option::is_none")]
    brace: Option<String>,
}

pub fn master_drawings(
    project: &Project,
    target: &fidel_core::DrawingTarget,
) -> Result<Vec<MasterDrawingView>, String> {
    let list = project.master_drawings(target).map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .map(|m| MasterDrawingView {
            master: m.master,
            d: fidel_core::svg_path(m.contours.iter().filter(|c| !c.open)),
            advance: m.advance,
            problem: m.problem,
            is_default: m.is_default,
            contours: m.contours,
            brace: m.brace,
        })
        .collect())
}

/// The design space as the masters panel shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignView {
    axes: Vec<fidel_core::designspace::Axis>,
    masters: Vec<MasterView>,
    instances: Vec<fidel_core::designspace::Instance>,
    /// Index of the master being edited.
    active: usize,
    /// Index of the master at the default location, if any.
    default: Option<usize>,
    /// Why the masters cannot interpolate, if they cannot.
    problem: Option<String>,
    incompatible: Vec<fidel_core::designspace::Incompatible>,
}

#[derive(Debug, Serialize)]
pub struct MasterView {
    id: String,
    name: String,
    location: std::collections::BTreeMap<String, f64>,
}

pub fn design_view(project: &Project) -> DesignView {
    let d = &project.design;
    let problem = if d.masters.len() > 1 { project.model().err().map(|e| e.to_string()) } else { None };
    DesignView {
        axes: d.axes.clone(),
        masters: d
            .masters
            .iter()
            .map(|m| MasterView { id: m.id.clone(), name: m.name.clone(), location: m.location.clone() })
            .collect(),
        instances: d.instances.clone(),
        active: d.active,
        default: d.default_master(),
        problem,
        incompatible: project.compatibility(),
    }
}

/// Kerning classes and pairs, as the kerning view shows them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KerningView {
    left_classes: Vec<KernClassView>,
    right_classes: Vec<KernClassView>,
    pairs: Vec<fidel_core::kerning::KernPair>,
}

#[derive(Debug, Serialize)]
pub struct KernClassView {
    name: String,
    /// Members as one string, in order.
    members: String,
}

pub fn kerning_view(project: &Project) -> KerningView {
    let k = &project.kerning;
    let classes = |m: &std::collections::BTreeMap<String, Vec<char>>| {
        m.iter()
            .map(|(name, members)| KernClassView { name: name.clone(), members: members.iter().collect() })
            .collect()
    };
    KerningView {
        left_classes: classes(&k.left_classes),
        right_classes: classes(&k.right_classes),
        pairs: k.pairs.clone(),
    }
}

/// A partner glyph placed against a drawing by their anchors, as an SVG
/// path in the drawing's coordinates.
pub fn mark_preview(
    project: &Project,
    target: &DrawingTarget,
    contours: Vec<Contour>,
    partner: &str,
) -> Option<String> {
    let partner = partner.chars().next()?;
    let (anchors, advance, own) = match target {
        DrawingTarget::Base(id) => {
            let b = project.bases.get(id)?;
            let own = project
                .families
                .values()
                .find(|f| &f.base == id)
                .and_then(|f| f.fidels.get(&Order::Giiz))
                .and_then(|f| f.codepoint);
            (b.anchors.clone(), b.advance_width, own)
        }
        DrawingTarget::Symbol(id) => {
            let s = project.symbols.get(id)?;
            (s.anchors.clone(), s.advance_width, Some(s.codepoint))
        }
        _ => return None,
    };
    let shape = fidel_core::marks::GlyphShape { contours, advance, anchors };
    project.mark_preview(&shape, own, partner).map(|c| fidel_core::svg_path(&c))
}

/// The feature code, what the project generates around it, and whether it
/// compiles.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturesView {
    features: fidel_core::features::Features,
    /// The generated part of the feature file, read-only.
    generated: String,
    /// Script, language tag and name of each language system on offer.
    languages: Vec<(String, String, String)>,
    /// Kerning classes as the code names them: `@L.ha`, and their members.
    kern_classes: Vec<(String, String)>,
    /// Feature tags in the compiled font.
    tags: Vec<String>,
    messages: Vec<fidel_export::features::FeatureMessage>,
    ok: bool,
}

pub fn features_view(project: &Project) -> FeaturesView {
    use fidel_core::features::{kern_class_name, LANGUAGES};
    use fidel_core::kerning::KernSide;
    let chars = fidel_export::exported_chars(project);
    let names = fidel_export::features::glyph_order(&chars);
    let has = |c: char| chars.contains(&c);
    let src = project.feature_source(&has);
    let (tags, messages, ok) = match fidel_export::features::compile(project, &names, 256) {
        Ok(l) => (l.tags, l.warnings, true),
        Err(e) => (fidel_core::features::feature_tags(&src.text), e, false),
    };
    let mut kern_classes = Vec::new();
    for side in [KernSide::Left, KernSide::Right] {
        for (n, m) in project.kerning.classes(side) {
            kern_classes.push((format!("@{}", kern_class_name(side, n)), m.iter().collect()));
        }
    }
    FeaturesView {
        features: project.features.clone(),
        generated: src.text[..src.code_start].to_string(),
        languages: LANGUAGES.iter().map(|(s, l, n)| (s.to_string(), l.to_string(), n.to_string())).collect(),
        kern_classes,
        tags,
        messages,
        ok,
    }
}

/// Marks, tags, notes and saved filters for the grid, with which drawings
/// have a background layer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeView {
    marks: std::collections::BTreeMap<String, fidel_core::organize::GlyphMark>,
    filters: Vec<fidel_core::organize::SmartFilter>,
    tags: Vec<String>,
    backgrounds: Vec<String>,
}

pub fn organize_view(project: &Project) -> OrganizeView {
    OrganizeView {
        marks: project.organize.marks.clone(),
        filters: project.organize.filters.clone(),
        tags: project.organize.tags(),
        backgrounds: project.backgrounds.keys().cloned().collect(),
    }
}
