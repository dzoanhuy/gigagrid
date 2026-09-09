mod commands;
mod index;
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
            commands::goto
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
