pub mod bridge;
pub mod commands;
pub mod config;
pub mod engine;
pub mod workspace;

use crate::engine::Engine;
use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub engine: Arc<Engine>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let engine = Engine::start_runtime(app.handle().clone());
            app.manage(AppState { engine });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_status,
            commands::engine_restart,
            commands::rpc_request,
            commands::rpc_notify,
            commands::rpc_respond,
            commands::pick_workspace,
            commands::list_workspace,
            commands::read_workspace_file,
            commands::get_settings,
            commands::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
