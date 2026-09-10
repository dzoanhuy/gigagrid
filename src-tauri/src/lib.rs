mod commands;
mod index;
mod overlay;
mod save;
mod search;

use tauri::{Emitter, RunEvent};
// Only used by the macOS/iOS/Android `RunEvent::Opened` arm below (for
// `.state::<PendingOpen>()`) — cfg-gated the same way so Windows/Linux
// builds don't carry an unused-import warning for a trait they never call.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_arg = std::env::args().nth(1).filter(|a| commands::is_csv_or_tsv(a));
    let pending_open = commands::PendingOpen(std::sync::Mutex::new(initial_arg));

    tauri::Builder::default()
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
        .manage(pending_open)
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
            commands::clear_view,
            commands::insert_row,
            commands::delete_row,
            commands::insert_col,
            commands::delete_col,
            commands::save_file,
            commands::close_tab,
            commands::take_pending_open
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
