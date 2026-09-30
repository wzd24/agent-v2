pub mod automations;
pub mod bridge;
pub mod browser;
pub mod commands;
pub mod config;
pub mod editors;
pub mod engine;
pub mod git;
pub mod githost;
pub mod hooks;
pub mod host;
pub mod mcp;
pub mod plugins;
pub mod preview;
pub mod projects;
pub mod runtime;
pub mod skills;
pub mod terminal;
pub mod threads;
pub mod tray;
pub mod updates;
pub mod workspace;

use crate::engine::Engine;
use crate::terminal::TerminalHub;
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub engine: Arc<Engine>,
    pub terminals: Arc<TerminalHub>,
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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            crate::tray::show_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !crate::tray::QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_close();
                    let window = window.clone();
                    let _ = window.run_on_main_thread({
                        let window = window.clone();
                        move || crate::tray::hide_window(window.app_handle())
                    });
                }
            }
            tauri::WindowEvent::Destroyed => {
                crate::browser::forget_alt_f4_guard(window.label());
                crate::browser::forget_alt_f4_guard("workspace-browser");
            }
            _ => {}
        })
        .setup(|app| {
            let engine = Engine::start_runtime(app.handle().clone());
            app.manage(AppState {
                engine,
                terminals: Arc::new(TerminalHub::new()),
            });
            if let Err(err) = crate::tray::install(app.handle()) {
                tracing::warn!("tray setup failed: {err}");
            }
            crate::browser::hide_if_open(app.handle());
            crate::host::grant_asset_scopes(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            crate::browser::install_alt_f4_guard(app.handle(), "main");
            if std::env::args().any(|arg| arg == "--demo") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    let _ = handle.emit("tray://action", serde_json::json!({ "action": "demo" }));
                });
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::host::tick_automations(handle.clone()).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                    crate::host::tick_automations(handle.clone()).await;
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                crate::host::maybe_startup_update_check(handle.clone()).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(15 * 60)).await;
                    crate::host::maybe_startup_update_check(handle.clone()).await;
                }
            });
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
            host::host_call,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
