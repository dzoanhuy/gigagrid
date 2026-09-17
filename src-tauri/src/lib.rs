mod commands;
mod index;
mod overlay;
mod save;
mod search;

use tauri::{Emitter, Manager, RunEvent};

#[cfg(desktop)]
fn create_app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = tauri::menu::AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let save_file_item = tauri::menu::MenuItemBuilder::with_id("save-file", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;

    let close_tab_item = tauri::menu::MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let close_window_item = tauri::menu::MenuItemBuilder::with_id("close-window", "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;

    let window_menu = tauri::menu::Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &tauri::menu::PredefinedMenuItem::minimize(app, None)?,
            &tauri::menu::PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &tauri::menu::PredefinedMenuItem::separator(app)?,
        ],
    )?;

    let help_menu = tauri::menu::Submenu::with_id_and_items(
        app,
        tauri::menu::HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &tauri::menu::PredefinedMenuItem::about(app, None, Some(about_metadata.clone()))?,
        ],
    )?;

    let file_menu = tauri::menu::Submenu::with_items(
        app,
        "File",
        true,
        &[
            &save_file_item,
            &tauri::menu::PredefinedMenuItem::separator(app)?,
            &close_tab_item,
            &close_window_item,
            #[cfg(not(target_os = "macos"))]
            &tauri::menu::PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_menu = tauri::menu::Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &tauri::menu::PredefinedMenuItem::undo(app, None)?,
            &tauri::menu::PredefinedMenuItem::redo(app, None)?,
            &tauri::menu::PredefinedMenuItem::separator(app)?,
            &tauri::menu::PredefinedMenuItem::cut(app, None)?,
            &tauri::menu::PredefinedMenuItem::copy(app, None)?,
            &tauri::menu::PredefinedMenuItem::paste(app, None)?,
            &tauri::menu::PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let menu = tauri::menu::Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &tauri::menu::Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &tauri::menu::PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &tauri::menu::PredefinedMenuItem::separator(app)?,
                    &tauri::menu::PredefinedMenuItem::services(app, None)?,
                    &tauri::menu::PredefinedMenuItem::separator(app)?,
                    &tauri::menu::PredefinedMenuItem::hide(app, None)?,
                    &tauri::menu::PredefinedMenuItem::hide_others(app, None)?,
                    &tauri::menu::PredefinedMenuItem::separator(app)?,
                    &tauri::menu::PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &file_menu,
            &edit_menu,
            #[cfg(target_os = "macos")]
            &tauri::menu::Submenu::with_items(
                app,
                "View",
                true,
                &[&tauri::menu::PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )?;

    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_arg = std::env::args().nth(1).filter(|a| commands::is_csv_or_tsv(a));
    let pending_open = commands::PendingOpen(std::sync::Mutex::new(initial_arg));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = args.into_iter().skip(1).find(|a| commands::is_csv_or_tsv(a)) {
                let _ = app.emit("open-file", path);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(std::sync::Mutex::new(commands::TabRegistry::new()))
        .manage(pending_open);

    #[cfg(desktop)]
    let builder = builder
        .menu(|app| create_app_menu(app))
        .on_menu_event(|app, event| {
            if event.id() == "save-file" {
                let _ = app.emit("save-active-file", ());
            } else if event.id() == "close-tab" {
                let _ = app.emit("close-active-tab", ());
            } else if event.id() == "close-window" {
                for window in app.webview_windows().values() {
                    let _ = window.close();
                }
            }
        });

    builder
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::get_rows,
            commands::search,
            commands::count_matches,
            commands::replace_all,
            commands::replace_cell,
            commands::goto,
            commands::set_cell,
            commands::set_cells_batch,
            commands::undo,
            commands::redo,
            commands::set_sort,
            commands::set_filter,
            commands::clear_sort,
            commands::clear_view,
            commands::insert_row,
            commands::delete_row,
            commands::insert_col,
            commands::delete_col,
            commands::save_file,
            commands::close_tab,
            commands::take_pending_open,
            commands::set_encoding,
            commands::set_line_ending,
            commands::set_delimiter
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Keeps `app_handle` "used" on targets where the match below
            // compiles down to just `_ => {}` (see comment on the Opened arm).
            let _ = &app_handle;
            match event {
                // `RunEvent::Opened` only EXISTS on macOS/iOS/Android — matching
                // it unconditionally fails to compile on Windows/Linux (that
                // variant isn't in the enum on those targets at all, not just
                // "never fires"). Windows/Linux get the opened path through the
                // single-instance callback / cold-start argv instead
                // (commands.rs PendingOpen), which doesn't go through RunEvent.
                // On a COLD launch (app wasn't running, user double-clicked/
                // Open-With'd a file), macOS delivers this Apple Event
                // essentially immediately at process start — reliably BEFORE
                // the webview has loaded the frontend JS far enough to have
                // registered the `listen("open-file", ...)` handler in
                // App.tsx. `emit` doesn't queue/replay for a listener that
                // isn't there yet, so the file was silently dropped and only
                // the app itself launched (empty). Also stashing the path in
                // the same `PendingOpen` state Windows/Linux's cold-start argv
                // path already uses gives the frontend's guaranteed
                // `take_pending_open` poll-on-mount a second chance to pick
                // it up. Harmless for the WARM case (app already running,
                // frontend already mounted so its poll-on-mount already ran
                // once and won't run again) — the emit is what that case
                // relies on, and this stashed value just sits unread.
                #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
                RunEvent::Opened { urls } => {
                    if let Some(url) = urls.first() {
                        if let Ok(path) = url.to_file_path() {
                            let path_str = path.to_string_lossy().to_string();
                            *app_handle.state::<commands::PendingOpen>().0.lock().unwrap() =
                                Some(path_str.clone());
                            let _ = app_handle.emit("open-file", path_str);
                        }
                    }
                }
                _ => {}
            }
        });
}
