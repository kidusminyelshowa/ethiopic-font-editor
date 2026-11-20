//! Tauri shell. The UI calls the commands below; all font logic lives in
//! `fidel-core`.

mod editor;
mod grid;

use std::sync::Mutex;

use fidel_core::{defaults::geez_project, Contour, DrawingTarget, Metrics, Order, Project};
use serde::Serialize;
use tauri::State;

use editor::{AlterationSummary, DrawingView, FidelPreview};
use grid::{FidelDetail, FidelGrid};

/// The open project. One per window for now; .kid loading comes with ETH-2.
pub struct AppState {
    project: Mutex<Project>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState { project: Mutex::new(geez_project(Metrics::default())) }
    }
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
    state.project.lock().expect("project lock").set_drawing(&target, contours).map_err(err)
}

#[tauri::command]
fn set_advance(state: State<'_, AppState>, base: String, advance_width: f64) -> CmdResult<()> {
    let mut project = state.project.lock().expect("project lock");
    let b = project.bases.get_mut(&base).ok_or_else(|| format!("no base `{base}`"))?;
    b.advance_width = advance_width.max(0.0);
    Ok(())
}

#[tauri::command]
fn family_preview(state: State<'_, AppState>, family: String) -> CmdResult<Vec<FidelPreview>> {
    editor::family_preview(&state.project.lock().expect("project lock"), &family).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            fidel_grid,
            fidel_detail,
            list_alterations,
            get_drawing,
            set_drawing,
            set_advance,
            family_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
