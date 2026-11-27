//! Tauri shell. The UI calls the commands below; all font logic lives in
//! `fidel-core`.

mod editor;
mod grid;
mod install;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use fidel_core::{
    defaults::starter_project, kid, CharSet, ComponentKind, ComponentRef, Contour, DrawingTarget, FontInfo,
    Language, Metrics, Order, Project, Scope, Vec2,
};
use serde::Serialize;
use tauri::State;

use editor::{AlterationSummary, DrawingView, FidelPreview};
use grid::{FidelDetail, FidelGrid};

/// The open project, where it lives on disk, and whether it has unsaved changes.
pub struct AppState {
    project: Mutex<Project>,
    file: Mutex<OpenFile>,
}

#[derive(Default)]
struct OpenFile {
    path: Option<PathBuf>,
    dirty: bool,
}

impl Default for AppState {
    fn default() -> Self {
        AppState { project: Mutex::new(starter_project(Metrics::default())), file: Mutex::default() }
    }
}

impl AppState {
    fn project(&self) -> MutexGuard<'_, Project> {
        self.project.lock().expect("project lock")
    }

    fn mark_dirty(&self) {
        self.file.lock().expect("file lock").dirty = true;
    }

    fn info(&self) -> ProjectInfo {
        let file = self.file.lock().expect("file lock");
        ProjectInfo {
            name: file
                .path
                .as_ref()
                .and_then(|p| p.file_stem())
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Untitled".into()),
            path: file.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            dirty: file.dirty,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    name: String,
    path: Option<String>,
    dirty: bool,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    app_version: &'static str,
    core_version: &'static str,
    family_count: usize,
    alteration_count: usize,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    let project = state.project.lock().expect("project lock");
    AppInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        core_version: fidel_core::VERSION,
        family_count: project.families.len(),
        alteration_count: project.alterations.len(),
    }
}

#[tauri::command]
fn fidel_grid(state: State<'_, AppState>) -> FidelGrid {
    FidelGrid::from_project(&state.project.lock().expect("project lock"))
}

#[tauri::command]
fn fidel_detail(state: State<'_, AppState>, family: String, order: Order) -> CmdResult<FidelDetail> {
    FidelDetail::from_project(&state.project.lock().expect("project lock"), &family, order).map_err(err)
}

#[tauri::command]
fn list_alterations(state: State<'_, AppState>) -> Vec<AlterationSummary> {
    editor::alteration_summaries(&state.project.lock().expect("project lock"))
}

#[tauri::command]
fn get_drawing(
    state: State<'_, AppState>,
    target: DrawingTarget,
    context_family: Option<String>,
) -> CmdResult<DrawingView> {
    DrawingView::open(&state.project.lock().expect("project lock"), target, context_family.as_deref())
        .map_err(err)
}

/// The character a drawing is for, and its alternates.
#[derive(serde::Serialize)]
struct AlternatesView {
    of: Option<char>,
    list: Vec<(String, String)>,
    duplicates: Vec<(char, Vec<String>)>,
}

#[tauri::command]
fn alternates_of(state: State<'_, AppState>, target: DrawingTarget) -> AlternatesView {
    let p = state.project();
    let of = p.char_of(&target);
    let list = of
        .map(|c| p.alternates_of(c).iter().map(|a| (a.id.clone(), a.label())).collect())
        .unwrap_or_default();
    AlternatesView { of, list, duplicates: p.duplicate_codepoints() }
}

#[tauri::command]
fn add_alternate(state: State<'_, AppState>, of: char, suffix: String) -> CmdResult<String> {
    let id = state.project().add_alternate(of, &suffix).map_err(err)?;
    state.mark_dirty();
    Ok(id)
}

#[tauri::command]
fn remove_alternate(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.project().remove_alternate(&id).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

#[tauri::command]
fn set_symbol_codepoint(state: State<'_, AppState>, id: String, codepoint: char) -> CmdResult<()> {
    state.project().set_symbol_codepoint(&id, codepoint).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Add a brace layer of a base or symbol at a location in user units.
#[tauri::command]
fn add_brace(
    state: State<'_, AppState>,
    of: DrawingTarget,
    location: std::collections::BTreeMap<String, f64>,
) -> CmdResult<String> {
    let id = state.project().add_brace(of, &location).map_err(err)?;
    state.mark_dirty();
    Ok(id)
}

#[tauri::command]
fn remove_brace(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.project().remove_brace(&id).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// A drawing at a location in the design space, for the canvas preview.
#[tauri::command]
fn drawing_at(
    state: State<'_, AppState>,
    target: DrawingTarget,
    location: std::collections::BTreeMap<String, f64>,
) -> CmdResult<String> {
    let p = state.project().instance_at(&location).map_err(err)?;
    Ok(DrawingView::open(&p, target, None).map_err(err)?.outline_d())
}

#[tauri::command]
fn set_drawing(state: State<'_, AppState>, target: DrawingTarget, contours: Vec<Contour>) -> CmdResult<()> {
    state.project().set_drawing(&target, contours).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

#[tauri::command]
fn set_advance(state: State<'_, AppState>, target: DrawingTarget, advance_width: f64) -> CmdResult<()> {
    {
        let mut project = state.project();
        let w = advance_width.max(0.0);
        match &target {
            DrawingTarget::Base(id) => {
                project.bases.get_mut(id).ok_or_else(|| format!("no base `{id}`"))?.advance_width = w
            }
            DrawingTarget::Symbol(id) => {
                project.symbols.get_mut(id).ok_or_else(|| format!("no symbol `{id}`"))?.advance_width = w
            }
            DrawingTarget::Brace(id) => project.set_brace_advance(id, w).map_err(err)?,
            DrawingTarget::Alternate(id) => {
                project.alternates.get_mut(id).ok_or_else(|| format!("no alternate `{id}`"))?.advance_width =
                    w
            }
            DrawingTarget::Alteration(_) | DrawingTarget::Fidel(_) | DrawingTarget::Component(_) => {
                return Err("this drawing has no advance width of its own".into())
            }
        }
        project.after_edit();
    }
    state.mark_dirty();
    Ok(())
}

/// Cover these character sets and languages. Creates the rows and symbols
/// they need; turning one off only hides it.
#[tauri::command]
fn set_coverage(state: State<'_, AppState>, sets: Vec<CharSet>, languages: Vec<Language>) -> FidelGrid {
    let grid = {
        let mut project = state.project();
        project.set_coverage(sets, languages);
        FidelGrid::from_project(&project)
    };
    state.mark_dirty();
    grid
}

/// Move where an alteration attaches on every fidel of one family.
#[tauri::command]
fn set_attach_offset(
    state: State<'_, AppState>,
    family: String,
    alteration: String,
    offset: Vec2,
) -> CmdResult<()> {
    state.project().set_attach_offset(&family, &alteration, offset).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Pick which variant of an order rule a family uses.
#[tauri::command]
fn set_rule_variant(
    state: State<'_, AppState>,
    family: String,
    order: Order,
    variant: usize,
) -> CmdResult<FidelDetail> {
    let detail = {
        let mut project = state.project();
        project.set_rule_variant(&family, order, variant).map_err(err)?;
        FidelDetail::from_project(&project, &family, order).map_err(err)?
    };
    state.mark_dirty();
    Ok(detail)
}

/// Pick how a fidel's order is formed: one of the order's forms for the
/// whole family (`variant`), or "Draw it" for this fidel (`None`).
#[tauri::command]
fn set_form(
    state: State<'_, AppState>,
    family: String,
    order: Order,
    variant: Option<usize>,
) -> CmdResult<FidelDetail> {
    let form = variant.map_or(fidel_core::Form::Draw, fidel_core::Form::Variant);
    let detail = {
        let mut project = state.project();
        project.set_form(&family, order, form).map_err(err)?;
        FidelDetail::from_project(&project, &family, order).map_err(err)?
    };
    state.mark_dirty();
    Ok(detail)
}

/// Remove overlap, booleans, offset, expand stroke or a knife cut, on
/// contours the editor sends. Returns the contours that replace them.
#[tauri::command]
fn path_op(op: fidel_core::pathops::PathOp) -> Vec<fidel_core::Contour> {
    op.run()
}

/// Set the zone a deform lands on and how far it pulls.
#[tauri::command]
fn set_deform(
    state: State<'_, AppState>,
    id: String,
    zone: Option<String>,
    amount: Option<f64>,
) -> CmdResult<()> {
    state.project().set_deform(&id, zone, amount).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Move a Pa-height zone (or add one), at a height in font units.
#[tauri::command]
fn set_zone(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    position: f64,
) -> Vec<editor::ZoneView> {
    let zones = {
        let mut project = state.project();
        project.metrics.set_zone(&id, name.as_deref(), position);
        editor::zone_views(&project.metrics)
    };
    state.mark_dirty();
    zones
}

/// The guides for a drawing: its own and the global ones.
#[tauri::command]
fn get_guides(state: State<'_, AppState>, drawing: String) -> GuidesView {
    let project = state.project();
    GuidesView { local: project.guides.local(&drawing), global: project.guides.global.clone() }
}

/// Replace a drawing's guides and the global ones.
#[tauri::command]
fn set_guides(
    state: State<'_, AppState>,
    drawing: String,
    local: Vec<fidel_core::guides::Guide>,
    global: Vec<fidel_core::guides::Guide>,
) {
    state.project().guides.set(&drawing, local, global);
    state.mark_dirty();
}

/// A drawing's background layer.
#[tauri::command]
fn get_background(state: State<'_, AppState>, drawing: String) -> Vec<fidel_core::Contour> {
    state.project().backgrounds.get(&drawing).cloned().unwrap_or_default()
}

/// Replace a drawing's background layer; empty removes it.
#[tauri::command]
fn set_background(state: State<'_, AppState>, drawing: String, contours: Vec<fidel_core::Contour>) {
    let mut project = state.project();
    if contours.is_empty() {
        project.backgrounds.remove(&drawing);
    } else {
        project.backgrounds.insert(drawing, contours);
    }
    drop(project);
    state.mark_dirty();
}

#[derive(serde::Serialize)]
struct GuidesView {
    local: Vec<fidel_core::guides::Guide>,
    global: Vec<fidel_core::guides::Guide>,
}

#[tauri::command]
fn list_components(state: State<'_, AppState>) -> Vec<editor::ComponentSummary> {
    editor::component_summaries(&state.project.lock().expect("project lock"))
}

#[tauri::command]
fn add_component(state: State<'_, AppState>, name: String, kind: ComponentKind) -> String {
    let id = state.project().add_component(&name, kind);
    state.mark_dirty();
    id
}

#[tauri::command]
fn remove_component(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.project().remove_component(&id).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Where a component lands by rule.
#[tauri::command]
fn set_component_rule(
    state: State<'_, AppState>,
    id: String,
    lands_on: Vec<fidel_core::Part>,
    corners: fidel_core::CornerSide,
) -> CmdResult<()> {
    state.project().set_component_rule(&id, lands_on, corners).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Switch one rule placement on or off and set how it is adjusted.
#[tauri::command]
fn set_component_end(
    state: State<'_, AppState>,
    id: String,
    key: String,
    on: bool,
    tweak: fidel_core::Tweak,
) -> CmdResult<()> {
    state.project().set_component_end(&id, &key, on, tweak).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Replace the anchors of a base or symbol.
#[tauri::command]
fn set_anchors(
    state: State<'_, AppState>,
    target: DrawingTarget,
    anchors: std::collections::BTreeMap<String, Vec2>,
) -> CmdResult<()> {
    state.project().set_anchors(&target, anchors).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Build every undrawn accented letter from its base letter and accents.
#[tauri::command]
fn build_accents(state: State<'_, AppState>) -> usize {
    let n = state.project().build_accents();
    if n > 0 {
        state.mark_dirty();
    }
    n
}

/// Build a symbol from these characters (a letter, then accents), or draw
/// it by hand when empty.
#[tauri::command]
fn set_built_from(state: State<'_, AppState>, id: String, parts: String) -> CmdResult<()> {
    state.project().set_built_from(&id, parts.chars().collect()).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Turn a built letter into its own drawing.
#[tauri::command]
fn decompose_symbol(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.project().decompose_symbol(&id).ok_or("Could not build it")?;
    state.mark_dirty();
    Ok(())
}

/// Another glyph placed against the drawing open now, by their anchors:
/// an accent on this letter, or a letter under this accent.
#[tauri::command]
fn mark_preview(
    state: State<'_, AppState>,
    target: DrawingTarget,
    contours: Vec<fidel_core::Contour>,
    partner: String,
) -> Option<String> {
    editor::mark_preview(&state.project(), &target, contours, &partner)
}

/// The feature code and whether it compiles.
#[tauri::command]
fn get_features(state: State<'_, AppState>) -> editor::FeaturesView {
    editor::features_view(&state.project())
}

/// Save the feature code, classes, languages and set names, and check them.
#[tauri::command]
fn set_features(
    state: State<'_, AppState>,
    features: fidel_core::features::Features,
) -> editor::FeaturesView {
    let view = {
        let mut project = state.project();
        project.features = features;
        editor::features_view(&project)
    };
    state.mark_dirty();
    view
}

/// A part's own axes and states.
#[tauri::command]
fn get_part(state: State<'_, AppState>, id: String) -> CmdResult<fidel_core::parametric::PartView> {
    state.project().part_view(&id).map_err(err)
}

#[tauri::command]
fn part_preview(
    state: State<'_, AppState>,
    id: String,
    values: fidel_core::component::PartValues,
) -> CmdResult<String> {
    state.project().part_preview(&id, &values).map(|c| fidel_core::svg_path(&c)).map_err(err)
}

fn part_change(
    state: &State<'_, AppState>,
    id: &str,
    f: impl FnOnce(&mut Project) -> Result<(), fidel_core::parametric::PartError>,
) -> CmdResult<fidel_core::parametric::PartView> {
    let view = {
        let mut project = state.project();
        f(&mut project).map_err(|e| e.to_string())?;
        project.part_view(id).map_err(err)?
    };
    state.mark_dirty();
    Ok(view)
}

#[tauri::command]
fn set_part_axes(
    state: State<'_, AppState>,
    id: String,
    axes: Vec<fidel_core::PartAxis>,
) -> CmdResult<fidel_core::parametric::PartView> {
    part_change(&state, &id, |p| p.set_part_axes(&id, axes))
}

/// A new state, starting as a copy of the part's main drawing.
#[tauri::command]
fn add_part_state(
    state: State<'_, AppState>,
    id: String,
    location: fidel_core::PartValues,
) -> CmdResult<fidel_core::parametric::PartView> {
    part_change(&state, &id, |p| p.add_part_state(&id, location).map(|_| ()))
}

#[tauri::command]
fn set_part_state(
    state: State<'_, AppState>,
    id: String,
    index: usize,
    location: fidel_core::PartValues,
) -> CmdResult<fidel_core::parametric::PartView> {
    part_change(&state, &id, |p| p.set_part_state(&id, index, location))
}

#[tauri::command]
fn remove_part_state(
    state: State<'_, AppState>,
    id: String,
    index: usize,
) -> CmdResult<fidel_core::parametric::PartView> {
    part_change(&state, &id, |p| p.remove_part_state(&id, index))
}

/// Every rule placement on a base, the ones switched off included.
#[tauri::command]
fn rule_ends(state: State<'_, AppState>, base: String) -> Vec<editor::RuleEnd> {
    editor::rule_ends(&state.project(), &base)
}

/// Make a derived base (ሸ from ሰ) follow its source again, or keep its own drawing.
#[tauri::command]
fn set_base_follows(state: State<'_, AppState>, base: String, follows: bool) -> CmdResult<()> {
    state.project().set_base_follows(&base, follows).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Give every other master this drawing's sidebearings. Returns how many changed.
#[tauri::command]
fn copy_metrics_to_masters(state: State<'_, AppState>, target: DrawingTarget) -> CmdResult<usize> {
    let n = state.project().copy_metrics_to_masters(&target).map_err(err)?;
    state.mark_dirty();
    Ok(n)
}

/// Set the metric keys of a base or symbol (`=ሀ+10`) and apply them.
#[tauri::command]
fn set_metric_keys(
    state: State<'_, AppState>,
    target: DrawingTarget,
    keys: fidel_core::metric_keys::MetricKeys,
) -> CmdResult<()> {
    state.project().set_metric_keys(&target, keys).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Axes, masters, instances and what keeps them from interpolating.
#[tauri::command]
fn get_design(state: State<'_, AppState>) -> editor::DesignView {
    editor::design_view(&state.project())
}

/// Run a change to the design space and return the new view.
fn design_change(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut fidel_core::Project) -> Result<(), fidel_core::designspace::DesignError>,
) -> CmdResult<editor::DesignView> {
    let view = {
        let mut project = state.project();
        f(&mut *project).map_err(err)?;
        editor::design_view(&project)
    };
    state.mark_dirty();
    Ok(view)
}

/// Add an axis, or change the one tagged `old_tag`.
#[tauri::command]
fn set_axis(
    state: State<'_, AppState>,
    old_tag: Option<String>,
    axis: fidel_core::designspace::Axis,
) -> CmdResult<editor::DesignView> {
    design_change(&state, |p| p.set_axis(old_tag.as_deref(), axis))
}

#[tauri::command]
fn remove_axis(state: State<'_, AppState>, tag: String) -> CmdResult<editor::DesignView> {
    design_change(&state, |p| {
        p.remove_axis(&tag);
        Ok(())
    })
}

/// A new master starting from the drawings of the one being edited.
#[tauri::command]
fn add_master(
    state: State<'_, AppState>,
    name: String,
    location: std::collections::BTreeMap<String, f64>,
) -> CmdResult<editor::DesignView> {
    design_change(&state, |p| {
        p.add_master(&name, location);
        Ok(())
    })
}

#[tauri::command]
fn set_master(
    state: State<'_, AppState>,
    index: usize,
    name: String,
    location: std::collections::BTreeMap<String, f64>,
) -> CmdResult<editor::DesignView> {
    design_change(&state, |p| p.set_master(index, &name, location))
}

#[tauri::command]
fn remove_master(state: State<'_, AppState>, index: usize) -> CmdResult<editor::DesignView> {
    design_change(&state, |p| p.remove_master(index))
}

/// Lean every drawing of the master being edited by some degrees.
#[tauri::command]
fn slant_master(state: State<'_, AppState>, degrees: f64) -> CmdResult<()> {
    if !degrees.is_finite() || degrees.abs() >= 45.0 {
        return Err("Slant by less than 45°".into());
    }
    state.project().slant_master(degrees);
    state.mark_dirty();
    Ok(())
}

/// Edit another master: its drawings come into the editor.
#[tauri::command]
fn switch_master(state: State<'_, AppState>, index: usize) -> CmdResult<editor::DesignView> {
    design_change(&state, |p| p.switch_master(index))
}

#[tauri::command]
fn set_instances(
    state: State<'_, AppState>,
    instances: Vec<fidel_core::designspace::Instance>,
) -> CmdResult<editor::DesignView> {
    design_change(&state, |p| {
        p.design.instances = instances;
        Ok(())
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableSummary {
    path: String,
    family_name: String,
    exported: usize,
    skipped: usize,
    /// Glyphs whose masters do not match, left as in the default master.
    fixed: Vec<String>,
}

/// The variable font over all masters.
#[tauri::command]
fn export_variable(state: State<'_, AppState>, path: String) -> CmdResult<VariableSummary> {
    let options = export_options(&state);
    let family_name = options.family_name.clone();
    let font = fidel_export::export_variable(&state.project(), &options).map_err(err)?;
    let path = with_extension(PathBuf::from(path), "ttf");
    std::fs::write(&path, &font.bytes).map_err(err)?;
    Ok(VariableSummary {
        path: path.to_string_lossy().into_owned(),
        family_name,
        exported: font.exported.len(),
        skipped: font.skipped.len(),
        fixed: font.fixed.iter().map(|c| c.to_string()).collect(),
    })
}

/// Each instance marked for export, as its own font in `dir`. Returns the paths.
#[tauri::command]
fn export_instances(state: State<'_, AppState>, dir: String) -> CmdResult<Vec<String>> {
    let options = export_options(&state);
    let project = state.project().clone();
    let mut out = Vec::new();
    for inst in project.design.instances.iter().filter(|i| i.export) {
        let font = fidel_export::export_instance(&project, inst, &options).map_err(err)?;
        let stem = format!("{}-{}", options.family_name, inst.name)
            .replace(|c: char| !c.is_alphanumeric() && c != '-', "");
        let path = PathBuf::from(&dir).join(format!("{stem}.ttf"));
        std::fs::write(&path, &font.bytes).map_err(err)?;
        out.push(path.to_string_lossy().into_owned());
    }
    if out.is_empty() {
        return Err("No instance is set to export.".into());
    }
    Ok(out)
}

/// A drawing in every master, with what keeps each from interpolating.
#[tauri::command]
fn master_drawings(
    state: State<'_, AppState>,
    target: DrawingTarget,
) -> CmdResult<Vec<editor::MasterDrawingView>> {
    editor::master_drawings(&state.project(), &target)
}

/// Line up every master's version of a drawing with the default master's.
#[tauri::command]
fn match_masters(state: State<'_, AppState>, target: DrawingTarget) -> CmdResult<usize> {
    let n = state.project().match_masters(&target).map_err(err)?;
    if n > 0 {
        state.mark_dirty();
    }
    Ok(n)
}

/// Kerning classes and pairs.
#[tauri::command]
fn get_kerning(state: State<'_, AppState>) -> editor::KerningView {
    editor::kerning_view(&state.project())
}

/// Set or remove (`value: null`) the kerning between two sides: a character
/// or `@class`.
#[tauri::command]
fn set_kern_pair(
    state: State<'_, AppState>,
    left: String,
    right: String,
    value: Option<i32>,
) -> CmdResult<editor::KerningView> {
    let view = {
        let mut project = state.project();
        project.kerning.set_pair(&left, &right, value).map_err(err)?;
        editor::kerning_view(&project)
    };
    state.mark_dirty();
    Ok(view)
}

/// Automatic spacing settings and the corpus counts.
#[tauri::command]
fn get_spacing(state: State<'_, AppState>) -> fidel_core::spacing::Spacing {
    state.project().spacing.clone()
}

/// Change the spacing settings; the corpus counts are kept.
#[tauri::command]
fn set_spacing(
    state: State<'_, AppState>,
    spacing: fidel_core::spacing::Spacing,
) -> fidel_core::spacing::Spacing {
    let mut p = state.project();
    let (letters, pairs) = (std::mem::take(&mut p.spacing.letters), std::mem::take(&mut p.spacing.pairs));
    p.spacing = fidel_core::spacing::Spacing { letters, pairs, ..spacing };
    state.mark_dirty();
    p.spacing.clone()
}

/// Count the letters and pairs of a text.
#[tauri::command]
fn read_corpus(state: State<'_, AppState>, text: String) -> fidel_core::spacing::Spacing {
    let mut p = state.project();
    p.read_corpus(&text);
    state.mark_dirty();
    p.spacing.clone()
}

/// Space bases and symbols to match the reference glyph. Returns how many changed.
#[tauri::command]
fn auto_space(state: State<'_, AppState>, only: Option<Vec<DrawingTarget>>) -> CmdResult<usize> {
    let n = state.project().auto_space(only.as_deref()).map_err(err)?;
    state.mark_dirty();
    Ok(n)
}

/// Kerning proposed for the corpus's most frequent pairs.
#[tauri::command]
fn propose_kerning(state: State<'_, AppState>) -> Vec<fidel_core::spacing::KernProposal> {
    state.project().propose_kerning()
}

/// Write proposed kerning. Pairs kerned by hand stay.
#[tauri::command]
fn apply_kerning(
    state: State<'_, AppState>,
    proposals: Vec<fidel_core::spacing::KernProposal>,
) -> CmdResult<editor::KerningView> {
    let view = {
        let mut p = state.project();
        p.apply_kerning(&proposals);
        editor::kerning_view(&p)
    };
    state.mark_dirty();
    Ok(view)
}

/// Give every other master this master's kerning. Returns how many changed.
#[tauri::command]
fn copy_kerning_to_masters(state: State<'_, AppState>) -> CmdResult<usize> {
    let n = state.project().copy_kerning_to_masters();
    state.mark_dirty();
    Ok(n)
}

/// Create, change, rename or remove (no members) a kerning class.
#[tauri::command]
fn set_kern_class(
    state: State<'_, AppState>,
    side: fidel_core::kerning::KernSide,
    name: String,
    members: String,
    rename: Option<String>,
) -> CmdResult<editor::KerningView> {
    let view = {
        let mut project = state.project();
        let members: Vec<char> = members.chars().collect();
        project.kerning.set_class(side, &name, &members, rename.as_deref()).map_err(err)?;
        editor::kerning_view(&project)
    };
    state.mark_dirty();
    Ok(view)
}

/// Marks, tags, notes and saved filters.
#[tauri::command]
fn get_organize(state: State<'_, AppState>) -> editor::OrganizeView {
    editor::organize_view(&state.project())
}

/// Set the colour, tags and note on a glyph (`fidel:ha/kaib`, `symbol:…`) or family (`family:ha`).
#[tauri::command]
fn set_mark(
    state: State<'_, AppState>,
    key: String,
    mark: fidel_core::organize::GlyphMark,
) -> editor::OrganizeView {
    let view = {
        let mut project = state.project();
        project.organize.set_mark(&key, mark);
        editor::organize_view(&project)
    };
    state.mark_dirty();
    view
}

#[tauri::command]
fn set_smart_filters(
    state: State<'_, AppState>,
    filters: Vec<fidel_core::organize::SmartFilter>,
) -> editor::OrganizeView {
    let view = {
        let mut project = state.project();
        project.organize.set_filters(filters);
        editor::organize_view(&project)
    };
    state.mark_dirty();
    view
}

/// Replace the components placed on a symbol (a numeral's frame).
#[tauri::command]
fn set_symbol_components(
    state: State<'_, AppState>,
    symbol: String,
    placements: Vec<ComponentRef>,
) -> CmdResult<()> {
    state.project().set_symbol_components(&symbol, placements).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Replace the components placed on one fidel (`family/order`).
#[tauri::command]
fn set_fidel_components(
    state: State<'_, AppState>,
    fidel: String,
    placements: Vec<ComponentRef>,
) -> CmdResult<()> {
    let (family, order) = fidel_core::DrawingTarget::fidel_ref(&fidel).map_err(err)?;
    state.project().set_fidel_components(&family, order, placements).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// Replace the components placed on a base.
#[tauri::command]
fn set_base_components(
    state: State<'_, AppState>,
    base: String,
    placements: Vec<ComponentRef>,
) -> CmdResult<()> {
    state.project().set_base_components(&base, placements).map_err(err)?;
    state.mark_dirty();
    Ok(())
}

/// The font's names and vertical metrics, for the grid's properties panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontProperties {
    info: FontInfo,
    metrics: Metrics,
    /// The name used when the family name is left empty.
    default_family_name: String,
    glyphs: usize,
    drawn: usize,
}

#[tauri::command]
fn font_properties(state: State<'_, AppState>) -> FontProperties {
    let default_family_name = state.info().name;
    let project = state.project();
    let options = fidel_export::ExportOptions::new("Count");
    let drawn = fidel_export::export(&project, &options).map(|f| f.exported.len()).unwrap_or(0);
    let grid = FidelGrid::from_project(&project);
    FontProperties {
        info: project.info.clone(),
        metrics: project.metrics.clone(),
        default_family_name,
        glyphs: grid.glyph_count(),
        drawn,
    }
}

#[tauri::command]
fn set_font_properties(
    state: State<'_, AppState>,
    info: FontInfo,
    pa_top: f64,
    pa_bottom: f64,
    italic_angle: Option<f64>,
) -> CmdResult<()> {
    if pa_top <= pa_bottom {
        return Err("Pa-top must be above Pa-bottom".into());
    }
    {
        let mut project = state.project();
        project.info = info;
        project.metrics.pa_top = pa_top;
        project.metrics.pa_bottom = pa_bottom;
        if let Some(a) = italic_angle {
            project.metrics.italic_angle = a;
        }
    }
    state.mark_dirty();
    Ok(())
}

#[tauri::command]
fn project_info(state: State<'_, AppState>) -> ProjectInfo {
    state.info()
}

/// Start over with an empty Ge'ez project.
#[tauri::command]
fn new_project(state: State<'_, AppState>) -> ProjectInfo {
    *state.project() = starter_project(Metrics::default());
    *state.file.lock().expect("file lock") = OpenFile::default();
    state.info()
}

#[tauri::command]
fn open_project(state: State<'_, AppState>, path: String) -> CmdResult<ProjectInfo> {
    let path = PathBuf::from(path);
    let project = kid::open(&path).map_err(err)?;
    *state.project() = project;
    *state.file.lock().expect("file lock") = OpenFile { path: Some(path), dirty: false };
    Ok(state.info())
}

/// Save to `path`, or to the current file when `path` is not given.
#[tauri::command]
fn save_project(state: State<'_, AppState>, path: Option<String>) -> CmdResult<ProjectInfo> {
    let target = match path {
        Some(p) => with_kid_extension(PathBuf::from(p)),
        None => state.file.lock().expect("file lock").path.clone().ok_or("choose where to save first")?,
    };
    kid::save(&state.project(), &target).map_err(err)?;
    *state.file.lock().expect("file lock") = OpenFile { path: Some(target), dirty: false };
    Ok(state.info())
}

fn with_kid_extension(path: PathBuf) -> PathBuf {
    with_extension(path, kid::EXTENSION)
}

fn with_extension(path: PathBuf, ext: &str) -> PathBuf {
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)) {
        path
    } else {
        let mut s = path.into_os_string();
        s.push(".");
        s.push(ext);
        PathBuf::from(s)
    }
}

/// What an export wrote, for the toast.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    path: String,
    family_name: String,
    exported: usize,
    skipped: usize,
}

/// Export the drawn fidel as an installable TrueType-flavoured OpenType font.
/// The family name is the project's name.
#[tauri::command]
fn export_font(state: State<'_, AppState>, path: String) -> CmdResult<ExportSummary> {
    let options = export_options(&state);
    let family_name = options.family_name.clone();
    let font = fidel_export::export(&state.project().default_project(), &options).map_err(err)?;
    let path = with_extension(PathBuf::from(path), "ttf");
    std::fs::write(&path, &font.bytes).map_err(err)?;
    Ok(ExportSummary {
        path: path.to_string_lossy().into_owned(),
        family_name,
        exported: font.exported.len(),
        skipped: font.skipped.len(),
    })
}

/// Export settings from the font info, named after the project when the
/// family name is empty.
fn export_options(state: &State<'_, AppState>) -> fidel_export::ExportOptions {
    let (family_name, info) = {
        let project = state.project();
        let info = project.info.clone();
        let name =
            if info.family_name.trim().is_empty() { state.info().name } else { info.family_name.clone() };
        (name, info)
    };
    let mut options = fidel_export::ExportOptions::new(family_name);
    if !info.style_name.trim().is_empty() {
        options.style_name = info.style_name.clone();
    }
    options.version = info.version;
    options.designer = info.designer.clone();
    // A fresh timestamp each time helps Windows notice a reinstalled font.
    options.timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    options
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSummary {
    path: String,
    family_name: String,
    exported: usize,
}

/// Install the current font for this user, replacing the last test copy.
#[tauri::command]
fn test_install(state: State<'_, AppState>) -> CmdResult<InstallSummary> {
    let options = export_options(&state);
    let font = fidel_export::export(&state.project().default_project(), &options).map_err(err)?;
    if font.exported.is_empty() {
        return Err("Nothing is drawn yet.".into());
    }
    let path = install::install(&font.bytes, &options.family_name, options.timestamp)?;
    Ok(InstallSummary {
        path: path.to_string_lossy().into_owned(),
        family_name: options.family_name,
        exported: font.exported.len(),
    })
}

/// The current drawings as font bytes, for the live proof line. Empty when
/// nothing is drawn yet.
#[tauri::command]
fn proof_font(
    state: State<'_, AppState>,
    location: Option<std::collections::BTreeMap<String, f64>>,
) -> tauri::ipc::Response {
    let options = fidel_export::ExportOptions {
        skip_bad_features: true,
        ..fidel_export::ExportOptions::new("Fidel Proof")
    };
    let project = match &location {
        Some(at) => state.project().instance_at(at).ok(),
        None => None,
    };
    let bytes = match project {
        Some(p) => fidel_export::export(&p, &options),
        None => fidel_export::export(&state.project(), &options),
    }
    .map(|f| f.bytes)
    .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

/// Which fidel an edit to this alteration reaches, and what happens to each.
#[tauri::command]
fn alteration_impacts(state: State<'_, AppState>, id: String) -> Vec<editor::ImpactView> {
    editor::alteration_impacts(&state.project(), &id)
}

/// The fidel an edit to a base reaches.
#[tauri::command]
fn base_impacts(state: State<'_, AppState>, id: String) -> Vec<editor::ImpactView> {
    editor::base_impacts(&state.project(), &id)
}

/// Give the fidel in `scope` their own copy of the alteration; returns its id.
#[tauri::command]
fn fork_alteration(state: State<'_, AppState>, id: String, scope: Scope) -> CmdResult<String> {
    let copy = state.project().fork_alteration(&id, &scope).map_err(err)?;
    state.mark_dirty();
    Ok(copy)
}

/// Put a copy's fidel back on the shared alteration; returns the shared id.
#[tauri::command]
fn rejoin_alteration(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let shared = state.project().rejoin_alteration(&id).map_err(err)?;
    state.mark_dirty();
    Ok(shared)
}

/// Build a fidel on another order of its family, or on the bare base again.
#[tauri::command]
fn set_built_on(
    state: State<'_, AppState>,
    family: String,
    order: Order,
    on: Option<Order>,
) -> CmdResult<FidelDetail> {
    let mut project = state.project();
    project.set_built_on(&family, order, on).map_err(err)?;
    let detail = FidelDetail::from_project(&project, &family, order).map_err(err)?;
    drop(project);
    state.mark_dirty();
    Ok(detail)
}

/// Bake a fidel's current outline into a hand-drawn copy.
#[tauri::command]
fn detach_fidel(state: State<'_, AppState>, family: String, order: Order) -> CmdResult<FidelDetail> {
    let mut project = state.project();
    project.detach(&family, order).map_err(err)?;
    let detail = FidelDetail::from_project(&project, &family, order).map_err(err)?;
    drop(project);
    state.mark_dirty();
    Ok(detail)
}

/// Drop a fidel's local edits and go back to its order rule.
#[tauri::command]
fn relink_fidel(state: State<'_, AppState>, family: String, order: Order) -> CmdResult<FidelDetail> {
    let mut project = state.project();
    project.relink(&family, order).map_err(err)?;
    let detail = FidelDetail::from_project(&project, &family, order).map_err(err)?;
    drop(project);
    state.mark_dirty();
    Ok(detail)
}

#[tauri::command]
fn family_preview(state: State<'_, AppState>, family: String) -> CmdResult<Vec<FidelPreview>> {
    editor::family_preview(&state.project.lock().expect("project lock"), &family).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            fidel_grid,
            fidel_detail,
            list_alterations,
            get_drawing,
            set_drawing,
            set_advance,
            set_coverage,
            set_attach_offset,
            font_properties,
            set_font_properties,
            family_preview,
            project_info,
            new_project,
            open_project,
            save_project,
            export_font,
            proof_font,
            alteration_impacts,
            base_impacts,
            fork_alteration,
            rejoin_alteration,
            set_built_on,
            detach_fidel,
            relink_fidel,
            set_rule_variant,
            set_form,
            path_op,
            set_deform,
            set_zone,
            get_guides,
            set_guides,
            get_background,
            set_background,
            list_components,
            add_component,
            remove_component,
            set_base_components,
            set_fidel_components,
            set_component_rule,
            set_component_end,
            rule_ends,
            get_features,
            set_anchors,
            build_accents,
            set_built_from,
            decompose_symbol,
            mark_preview,
            set_features,
            get_part,
            drawing_at,
            add_brace,
            alternates_of,
            add_alternate,
            remove_alternate,
            set_symbol_codepoint,
            remove_brace,
            part_preview,
            set_part_axes,
            add_part_state,
            set_part_state,
            remove_part_state,
            get_design,
            master_drawings,
            match_masters,
            set_axis,
            remove_axis,
            add_master,
            set_master,
            remove_master,
            switch_master,
            slant_master,
            set_instances,
            export_variable,
            export_instances,
            get_kerning,
            set_kern_pair,
            set_kern_class,
            get_organize,
            set_mark,
            set_smart_filters,
            test_install,
            set_base_follows,
            set_symbol_components,
            set_metric_keys,
            copy_metrics_to_masters,
            copy_kerning_to_masters,
            get_spacing,
            set_spacing,
            read_corpus,
            auto_space,
            propose_kerning,
            apply_kerning
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_the_kid_extension_once() {
        assert_eq!(with_kid_extension("a/Font".into()), PathBuf::from("a/Font.kid"));
        assert_eq!(with_kid_extension("a/Font.KID".into()), PathBuf::from("a/Font.KID"));
        assert_eq!(with_kid_extension("a/Font.v2".into()), PathBuf::from("a/Font.v2.kid"));
    }
}
