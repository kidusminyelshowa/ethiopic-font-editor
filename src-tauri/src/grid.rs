//! The Fidel Grid as the UI sees it: families as rows, orders as columns.

use fidel_core::{
    svg_path, Badge, FidelState, IrregularForm, Metrics, ModelError, Order, Project, ShapeGroup, StateKind,
};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderHeader {
    order: Order,
    number: u8,
    name: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridCell {
    order: Order,
    codepoint: Option<char>,
    state: StateKind,
    badge: Badge,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    /// The resolved outline, once there is something to draw.
    #[serde(skip_serializing_if = "Option::is_none")]
    outline: Option<Outline>,
}

/// A resolved fidel as SVG path data in font units (y up).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outline {
    pub d: String,
    pub advance_width: f64,
}

impl Outline {
    pub fn of(project: &Project, family: &str, order: Order) -> Option<Outline> {
        let r = project.resolve(family, order).ok()?;
        if r.contours.is_empty() {
            return None;
        }
        Some(Outline { d: svg_path(r.contours.iter().map(|c| &c.contour)), advance_width: r.advance_width })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRow {
    family: String,
    name: String,
    group: Option<ShapeGroup>,
    cells: Vec<GridCell>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelGrid {
    metrics: Metrics,
    orders: Vec<OrderHeader>,
    rows: Vec<GridRow>,
}

impl FidelGrid {
    pub fn from_project(project: &Project) -> Self {
        let orders = Order::ALL
            .iter()
            .map(|&order| OrderHeader { order, number: order.number(), name: order.name() })
            .collect();

        // Rows in chart order (by 1st-order codepoint), not alphabetical by id.
        let mut families: Vec<_> = project.families.values().collect();
        families.sort_by_key(|f| f.fidels.get(&Order::Giiz).and_then(|g| g.codepoint));

        let rows = families
            .into_iter()
            .map(|f| GridRow {
                family: f.id.clone(),
                name: f.name.clone(),
                group: f.group,
                cells: Order::ALL
                    .iter()
                    .filter_map(|o| f.fidels.get(o).map(|fidel| (o, fidel)))
                    .map(|(&order, fidel)| {
                        let state = fidel.state.kind();
                        let note = match &fidel.state {
                            FidelState::Irregular { note, .. } => note.clone(),
                            _ => None,
                        };
                        GridCell {
                            order,
                            codepoint: fidel.codepoint,
                            state,
                            badge: state.badge(),
                            note,
                            outline: Outline::of(project, &f.id, order),
                        }
                    })
                    .collect(),
            })
            .collect();

        FidelGrid { metrics: project.metrics.clone(), orders, rows }
    }
}

/// What the inspector shows for one selected fidel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelDetail {
    family: String,
    family_name: String,
    base_glyph: Option<char>,
    group: Option<ShapeGroup>,
    order: Order,
    order_number: u8,
    order_name: &'static str,
    codepoint: Option<char>,
    state: StateKind,
    badge: Badge,
    note: Option<String>,
    /// Alterations that build this fidel, with their display names.
    recipe: Vec<RecipeStep>,
    nudge_count: usize,
    /// The order this fidel starts from instead of the bare base.
    built_on: Option<OrderRef>,
    /// Orders built on this fidel, which follow any change to it.
    built_on_by: Vec<OrderRef>,
    /// Orders this fidel could be built on; empty when it is drawn by hand.
    built_on_choices: Vec<OrderRef>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRef {
    order: Order,
    order_name: &'static str,
    codepoint: Option<char>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeStep {
    id: String,
    name: String,
    drawn: bool,
}

impl FidelDetail {
    pub fn from_project(project: &Project, family: &str, order: Order) -> Result<Self, ModelError> {
        let fidel = project.fidel(family, order)?;
        let fam = &project.families[family];
        let state = fidel.state.kind();
        let note = match &fidel.state {
            FidelState::Irregular { note, .. } => note.clone(),
            _ => None,
        };
        let recipe = match state {
            StateKind::Detached => Vec::new(),
            _ => project
                .effective_alterations(family, order)?
                .into_iter()
                .map(|id| {
                    let alt = project.alterations.get(&id);
                    RecipeStep {
                        name: alt.map(|a| a.name.clone()).unwrap_or_else(|| id.clone()),
                        drawn: alt.is_some_and(|a| !a.contours.is_empty()),
                        id,
                    }
                })
                .collect(),
        };
        let order_ref = |o: Order| OrderRef {
            order: o,
            order_name: o.name(),
            codepoint: fam.fidels.get(&o).and_then(|f| f.codepoint),
        };
        // A Detached or drawn fidel ignores its link, so there is nothing to show.
        let generated = !matches!(
            fidel.state,
            FidelState::Detached { .. } | FidelState::Irregular { form: IrregularForm::Drawn { .. }, .. }
        );
        Ok(FidelDetail {
            built_on: fidel.built_on.filter(|_| generated).map(order_ref),
            built_on_by: project.built_on_by(family, order).into_iter().map(order_ref).collect(),
            built_on_choices: if generated {
                fam.fidels
                    .keys()
                    .filter(|o| **o != order && **o != Order::Giiz)
                    .map(|o| order_ref(*o))
                    .collect()
            } else {
                Vec::new()
            },
            family: fam.id.clone(),
            family_name: fam.name.clone(),
            base_glyph: fam.fidels.get(&Order::Giiz).and_then(|f| f.codepoint),
            group: fam.group,
            order,
            order_number: order.number(),
            order_name: order.name(),
            codepoint: fidel.codepoint,
            state,
            badge: state.badge(),
            note,
            recipe,
            nudge_count: fidel.state.nudges().len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fidel_core::{defaults::geez_project, Metrics};

    #[test]
    fn grid_follows_the_traditional_chart() {
        let grid = FidelGrid::from_project(&geez_project(Metrics::default()));
        assert_eq!(grid.orders.len(), 7);
        assert_eq!(grid.orders[4].name, "Hamis");
        assert_eq!(grid.rows.len(), 26);
        let first: String = grid.rows.iter().map(|r| r.cells[0].codepoint.unwrap()).collect();
        assert!(first.starts_with("ሀለሐመሠረሰቀበ"), "{first}");
        let mu = &grid.rows[3].cells[1];
        assert_eq!(mu.codepoint, Some('ሙ'));
        assert_eq!(mu.badge, Badge::Outlined);
    }

    #[test]
    fn grid_serialises_for_the_ui() {
        let grid = FidelGrid::from_project(&geez_project(Metrics::default()));
        let json = serde_json::to_value(&grid).unwrap();
        assert_eq!(json["rows"][0]["cells"][4]["codepoint"], "ሄ");
        assert_eq!(json["rows"][0]["cells"][4]["state"], "linked");
        assert_eq!(json["orders"][0]["name"], "Gi'iz");
    }

    #[test]
    fn detail_lists_the_recipe() {
        let p = geez_project(Metrics::default());
        let d = FidelDetail::from_project(&p, "la", Order::Hamis).unwrap();
        assert_eq!(d.codepoint, Some('ሌ'));
        assert_eq!(d.base_glyph, Some('ለ'));
        assert_eq!(d.order_name, "Hamis");
        assert_eq!(d.recipe.len(), 1);
        assert_eq!(d.recipe[0].id, "loop.bottom-right");
        assert!(!d.recipe[0].drawn);
        assert!(FidelDetail::from_project(&p, "nope", Order::Hamis).is_err());
    }
}
