//! Tauri shell. The UI calls the commands below; all font logic lives in
//! `fidel-core`.

mod grid;

use std::sync::Mutex;

use fidel_core::{defaults::geez_project, Metrics, Order, Project};
use serde::Serialize;
use tauri::State;

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
fn fidel_detail(state: State<'_, AppState>, family: String, order: Order) -> Result<FidelDetail, String> {
    FidelDetail::from_project(&state.project.lock().expect("project lock"), &family, order)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![app_info, fidel_grid, fidel_detail])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
