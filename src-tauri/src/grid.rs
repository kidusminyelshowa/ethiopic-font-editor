//! The Fidel Grid as the UI sees it: families as rows, orders as columns.

use fidel_core::{Badge, FidelState, Order, Project, ShapeGroup, StateKind};
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
                        GridCell { order, codepoint: fidel.codepoint, state, badge: state.badge(), note }
                    })
                    .collect(),
            })
            .collect();

        FidelGrid { orders, rows }
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
}
