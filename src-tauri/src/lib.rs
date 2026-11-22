//! Tauri shell. The UI calls the commands below; all font logic lives in
//! `fidel-core`.

mod editor;
mod grid;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use fidel_core::{defaults::geez_project, kid, Contour, DrawingTarget, Metrics, Order, Project};
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
        AppState { project: Mutex::new(geez_project(Metrics::default())), file: Mutex::default() }
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
                .unwrap_or_else(|| "Untitled Ge'ez".into()),
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
fn set_advance(state: State<'_, AppState>, base: String, advance_width: f64) -> CmdResult<()> {
    {
        let mut project = state.project();
        let b = project.bases.get_mut(&base).ok_or_else(|| format!("no base `{base}`"))?;
        b.advance_width = advance_width.max(0.0);
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
    *state.project() = geez_project(Metrics::default());
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
    let family_name = state.info().name;
    let mut options = fidel_export::ExportOptions::new(family_name.clone());
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
            family_preview,
            project_info,
            new_project,
            open_project,
            save_project,
            export_font,
            proof_font
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
