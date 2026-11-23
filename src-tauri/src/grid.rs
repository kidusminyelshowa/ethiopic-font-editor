//! The Fidel Grid as the UI sees it: families as rows, orders as columns.

use fidel_core::{
    charset, svg_path, Badge, CharSet, FidelState, IrregularForm, Language, Metrics, ModelError, Order,
    Project, ShapeGroup, StateKind,
};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderHeader {
    order: Order,
    number: u8,
    name: &'static str,
    /// A labialized or -oa column, shown only when a set needs it.
    extra: bool,
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
    /// The base this row is drawn from. Usually the family id; Sebatbeit and
    /// Gurage rows share the base of the plain row.
    base: String,
    group: Option<ShapeGroup>,
    /// The character set the row is listed under.
    section: CharSet,
    cells: Vec<GridCell>,
}

/// A punctuation mark, numeral or combining mark.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolCell {
    id: String,
    codepoint: char,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    outline: Option<Outline>,
}

/// One entry of the character set picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharSetInfo {
    id: CharSet,
    name: &'static str,
    range: &'static str,
    count: usize,
    enabled: bool,
}

pub fn charset_list(project: &Project) -> Vec<CharSetInfo> {
    let on = project.charsets();
    CharSet::ALL
        .iter()
        .map(|&id| CharSetInfo {
            id,
            name: id.name(),
            range: id.range(),
            count: id.count(),
            enabled: on.contains(&id),
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelGrid {
    metrics: Metrics,
    orders: Vec<OrderHeader>,
    rows: Vec<GridRow>,
    symbols: Vec<SymbolCell>,
    charsets: Vec<CharSetInfo>,
    languages: Vec<LanguageInfo>,
}

/// A language preset in the character set picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    id: Language,
    name: &'static str,
    count: usize,
    enabled: bool,
}

impl FidelGrid {
    /// Fidel and symbols in the covered sets.
    pub fn glyph_count(&self) -> usize {
        self.rows.iter().map(|r| r.cells.len()).sum::<usize>() + self.symbols.len()
    }
}

impl FidelGrid {
    pub fn from_project(project: &Project) -> Self {
        let visible = |c: Option<char>| c.is_none_or(|c| project.in_charset(c));
        let mut rows: Vec<(char, GridRow)> = project
            .families
            .values()
            .filter_map(|f| {
                let cells: Vec<GridCell> = Order::ALL
                    .iter()
                    .chain(Order::EXTRA.iter())
                    .filter_map(|o| f.fidels.get(o).map(|fidel| (o, fidel)))
                    .filter(|(_, fidel)| visible(fidel.codepoint))
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
                    .collect();
                // Listed under the set of its first character, and in chart
                // order by that character.
                let first = cells.iter().filter_map(|c| c.codepoint).min()?;
                let section = f
                    .fidels
                    .values()
                    .filter_map(|x| x.codepoint)
                    .min()
                    .and_then(charset::set_of)
                    .filter(|s| project.charsets().contains(s))
                    .or_else(|| charset::set_of(first))
                    .unwrap_or(CharSet::Geez);
                Some((
                    first,
                    GridRow {
                        family: f.id.clone(),
                        name: f.name.clone(),
                        base: f.base.clone(),
                        group: f.group,
                        section,
                        cells,
                    },
                ))
            })
            .collect();
        rows.sort_by_key(|(first, r)| (CharSet::ALL.iter().position(|s| *s == r.section), *first));
        let rows: Vec<GridRow> = rows.into_iter().map(|(_, r)| r).collect();

        let orders = Order::ALL
            .iter()
            .chain(
                Order::EXTRA.iter().filter(|o| rows.iter().any(|r| r.cells.iter().any(|c| c.order == **o))),
            )
            .map(|&order| OrderHeader {
                order,
                number: order.number(),
                name: order.name(),
                extra: !order.is_main(),
            })
            .collect();

        let symbols = project
            .symbols
            .values()
            .filter(|s| project.in_charset(s.codepoint))
            .map(|s| SymbolCell {
                id: s.id.clone(),
                codepoint: s.codepoint,
                name: s.name.clone(),
                outline: (!s.contours.is_empty())
                    .then(|| Outline { d: svg_path(&s.contours), advance_width: s.advance_width }),
            })
            .collect::<Vec<_>>();
        let mut symbols = symbols;
        symbols.sort_by_key(|s| s.codepoint);

        let languages = Language::ALL
            .iter()
            .map(|&id| LanguageInfo {
                id,
                name: id.name(),
                count: id.count(),
                enabled: project.languages.contains(&id),
            })
            .collect();
        FidelGrid {
            metrics: project.metrics.clone(),
            orders,
            rows,
            symbols,
            charsets: charset_list(project),
            languages,
        }
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
    /// Detached or drawn Irregular: the editor opens its own outline.
    drawn_by_hand: bool,
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
            drawn_by_hand: !generated,
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
        assert_eq!(mu.badge, Badge::None, "ሙ is መ with the 2nd-order mark");
        let ru = &grid.rows[5].cells[1];
        assert_eq!(ru.badge, Badge::Outlined);
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
    fn sets_add_rows_columns_and_symbols() {
        let mut p = geez_project(Metrics::default());
        p.set_charsets([
            CharSet::Geez,
            CharSet::EthiopicLetters,
            CharSet::EthiopicLabialized,
            CharSet::EthiopicMarks,
        ]);
        let grid = FidelGrid::from_project(&p);
        assert!(grid.orders.iter().any(|o| o.order == Order::Oa && o.extra));
        assert_eq!(grid.rows[0].section, CharSet::Geez);
        assert!(grid.rows.iter().any(|r| r.family == "sha" && r.section == CharSet::EthiopicLetters));
        let la = grid.rows.iter().find(|r| r.family == "la").unwrap();
        assert!(la.cells.iter().any(|c| c.codepoint == Some('ሏ')));
        assert!(grid.symbols.iter().any(|s| s.codepoint == '።'));

        // Turning a set off hides it but keeps the work.
        p.set_charsets([CharSet::Geez]);
        let grid = FidelGrid::from_project(&p);
        assert_eq!(grid.rows.len(), 26);
        assert_eq!(grid.orders.len(), 7);
        assert!(grid.symbols.is_empty());
        assert!(p.families.contains_key("sha"));
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
