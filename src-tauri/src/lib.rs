mod commands;
mod index;
mod overlay;
mod save;
mod search;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Mutex::new(None::<commands::OpenFile>))
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
            commands::save_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
