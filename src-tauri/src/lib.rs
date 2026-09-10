mod commands;
mod index;
mod overlay;
mod save;
mod search;

use tauri::{Emitter, RunEvent};

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
        .manage(std::sync::Mutex::new(commands::TabRegistry::new()))
        .manage(pending_open)
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::get_rows,
            commands::search,
            commands::count_matches,
            commands::goto,
            commands::set_cell,
            commands::set_cells_batch,
            commands::undo,
            commands::redo,
            commands::set_sort,
            commands::set_filter,
            commands::clear_view,
            commands::save_file,
            commands::close_tab,
            commands::take_pending_open
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Opened { urls } = event {
                if let Some(url) = urls.first() {
                    if let Ok(path) = url.to_file_path() {
                        let _ = app_handle.emit("open-file", path.to_string_lossy().to_string());
                    }
                }
            }
        });
}
