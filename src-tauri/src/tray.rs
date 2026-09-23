use crate::AppState;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
        crate::browser::restore_if_wanted(app);
    }
}

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app, &[])?;
    TrayIconBuilder::with_id("main")
        .tooltip("Local Codex")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or("缺少托盘图标")?,
        )
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => show_window(tray.app_handle()),
                _ => {}
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "quit" => {
                    QUITTING.store(true, Ordering::SeqCst);
                    app.exit(0);
                }
                "open-window" => show_window(app),
                "new-thread" => {
                    show_window(app);
                    let _ = app.emit("tray://action", json!({ "action": "new-thread" }));
                }
                "open-automations" => {
                    show_window(app);
                    let _ = app.emit("tray://action", json!({ "action": "open-automations" }));
                }
                "copy-diagnostics" => {
                    show_window(app);
                    let _ = app.emit("tray://action", json!({ "action": "copy-diagnostics" }));
                }
                other if other.starts_with("thread:") => {
                    let thread_id = other.trim_start_matches("thread:");
                    show_window(app);
                    let _ = app.emit(
                        "tray://action",
                        json!({ "action": "select-thread", "threadId": thread_id }),
                    );
                }
                _ => {}
            }
        })
        .build(app)?;
    refresh_recent(app);
    Ok(())
}

pub fn refresh_recent(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for delay in [0_u64, 1, 3, 8] {
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
            let recent = recent_threads(&app).await;
            if let Ok(menu) = build_menu(&app, &recent) {
                if let Some(icon) = app.tray_by_id("main") {
                    let _ = icon.set_menu(Some(menu));
                }
            }
            if !recent.is_empty() {
                break;
            }
        }
    });
}

fn build_menu(app: &AppHandle, recent: &[(String, String)]) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open-window", "打开窗口", true, None::<&str>)?;
    let new_thread = MenuItem::with_id(app, "new-thread", "新对话", true, None::<&str>)?;
    let automations = MenuItem::with_id(app, "open-automations", "自动化", true, None::<&str>)?;
    let diagnostics = MenuItem::with_id(app, "copy-diagnostics", "复制诊断", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let mut recent_items = Vec::new();
    if recent.is_empty() {
        recent_items.push(MenuItem::with_id(
            app,
            "recent-empty",
            "暂无最近线程",
            false,
            None::<&str>,
        )?);
    } else {
        for (id, label) in recent {
            recent_items.push(MenuItem::with_id(
                app,
                format!("thread:{id}"),
                label,
                true,
                None::<&str>,
            )?);
        }
    }
    let recent_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = recent_items
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    let recent_menu = Submenu::with_items(app, "最近", true, &recent_refs)?;
    let more = Submenu::with_items(app, "更多", true, &[&open])?;
    Menu::with_items(
        app,
        &[
            &recent_menu,
            &more,
            &PredefinedMenuItem::separator(app)?,
            &new_thread,
            &automations,
            &diagnostics,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

async fn recent_threads(app: &AppHandle) -> Vec<(String, String)> {
    let Some(state) = app.try_state::<AppState>() else {
        return Vec::new();
    };
    let Ok(result) = state
        .engine
        .request(
            "thread/list",
            json!({ "limit": 5, "sortKey": "recency_at", "sortDirection": "desc" }),
        )
        .await
    else {
        return Vec::new();
    };
    let result = crate::threads::hydrate_thread_list(result);
    let result = crate::projects::attach_project_ids(result);
    result
        .get("data")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|thread| thread.get("archived").and_then(serde_json::Value::as_bool) != Some(true))
        .filter_map(|thread| {
            let id = thread.get("id").and_then(serde_json::Value::as_str)?.to_string();
            let label = thread
                .get("title")
                .or_else(|| thread.get("name"))
                .or_else(|| thread.get("preview"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("未命名线程")
                .chars()
                .take(42)
                .collect::<String>();
            Some((id, label))
        })
        .take(5)
        .collect()
}
