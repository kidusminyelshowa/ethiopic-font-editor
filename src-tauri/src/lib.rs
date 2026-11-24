//! Tauri shell. The UI calls the commands below; all font logic lives in
//! `fidel-core`.

mod editor;
mod grid;

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
            DrawingTarget::Alteration(_) | DrawingTarget::Fidel(_) | DrawingTarget::Component(_) => {
                return Err("this drawing has no advance width of its own".into())
            }
        }
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
) -> CmdResult<()> {
    if pa_top <= pa_bottom {
        return Err("Pa-top must be above Pa-bottom".into());
    }
    {
        let mut project = state.project();
        project.info = info;
        project.metrics.pa_top = pa_top;
        project.metrics.pa_bottom = pa_bottom;
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
    let (family_name, info) = {
        let project = state.project();
        let info = project.info.clone();
        let name =
            if info.family_name.trim().is_empty() { state.info().name } else { info.family_name.clone() };
        (name, info)
    };
    let mut options = fidel_export::ExportOptions::new(family_name.clone());
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
    let font = fidel_export::export(&state.project(), &options).map_err(err)?;
    let path = with_extension(PathBuf::from(path), "ttf");
    std::fs::write(&path, &font.bytes).map_err(err)?;
    Ok(ExportSummary {
        path: path.to_string_lossy().into_owned(),
        family_name,
        exported: font.exported.len(),
        skipped: font.skipped.len(),
    })
}

/// The current drawings as font bytes, for the live proof line. Empty when
/// nothing is drawn yet.
#[tauri::command]
fn proof_font(state: State<'_, AppState>) -> tauri::ipc::Response {
    let options = fidel_export::ExportOptions::new("Fidel Proof");
    let bytes = fidel_export::export(&state.project(), &options).map(|f| f.bytes).unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

/// Which fidel an edit to this alteration reaches, and what happens to each.
#[tauri::command]
fn alteration_impacts(state: State<'_, AppState>, id: String) -> Vec<editor::ImpactView> {
    editor::alteration_impacts(&state.project(), &id)
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
            list_components,
            add_component,
            remove_component,
            set_base_components
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
