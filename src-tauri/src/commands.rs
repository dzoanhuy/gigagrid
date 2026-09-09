use crate::index::CsvIndex;
use crate::overlay::Overlay;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// Currently open file: the index (read-only over the raw file), the path
/// so a read command can (re)open the underlying `File` handle, and the
/// edit overlay (phase 05) merged into every read.
pub struct OpenFile {
    pub path: PathBuf,
    pub index: CsvIndex,
    pub overlay: Overlay,
}

pub type AppState = Mutex<Option<OpenFile>>;

#[derive(serde::Serialize)]
pub struct FileMeta {
    pub path: String,
    pub row_count: usize,
}

#[tauri::command]
pub fn open_file(path: String, state: State<AppState>) -> Result<FileMeta, String> {
    let p = PathBuf::from(&path);
    let index = CsvIndex::build(&p).map_err(|e| e.to_string())?;
    let row_count = index.row_count();
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    *guard = Some(OpenFile {
        path: p,
        index,
        overlay: Overlay::new(),
    });
    Ok(FileMeta { path, row_count })
}

#[tauri::command]
pub fn get_rows(
    start: usize,
    count: usize,
    state: State<AppState>,
) -> Result<Vec<Vec<String>>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.as_ref().ok_or_else(|| "no file open".to_string())?;
    get_rows_impl(open_file, start, count)
}

/// Logic shared by the `get_rows` command, factored out so it is testable
/// without a live Tauri `State` (constructing a real `tauri::State` outside
/// a running app is impractical). Every cell checks the overlay FIRST,
/// falling back to the raw file value — see overlay.rs for why this must
/// never be skipped.
fn get_rows_impl(
    open_file: &OpenFile,
    start: usize,
    count: usize,
) -> Result<Vec<Vec<String>>, String> {
    let mut file = File::open(&open_file.path).map_err(|e| e.to_string())?;
    let row_count = open_file.index.row_count();
    let end = (start + count).min(row_count);
    let mut rows = Vec::with_capacity(end.saturating_sub(start));
    for r in start..end {
        let mut row = open_file
            .index
            .read_row(&mut file, r)
            .map_err(|e| e.to_string())?;
        for (c, cell) in row.iter_mut().enumerate() {
            if let Some(edited) = open_file.overlay.get(r, c) {
                *cell = edited.clone();
            }
        }
        rows.push(row);
    }
    Ok(rows)
}

#[tauri::command]
pub fn set_cell(
    row: usize,
    col: usize,
    value: String,
    state: State<AppState>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.as_mut().ok_or_else(|| "no file open".to_string())?;
    open_file.overlay.set(row, col, value);
    Ok(())
}

#[tauri::command]
pub fn search(
    query: String,
    from_row: usize,
    direction: String,
    state: State<AppState>,
) -> Result<Option<usize>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.as_ref().ok_or_else(|| "no file open".to_string())?;
    let mut file = File::open(&open_file.path).map_err(|e| e.to_string())?;
    let result = if direction == "prev" {
        crate::search::find_prev(&open_file.index, &mut file, &query, from_row)
    } else {
        crate::search::find_next(&open_file.index, &mut file, &query, from_row)
    };
    Ok(result)
}

/// Validates `row` against the open file's row count. Column bounds are not
/// tracked by `CsvIndex` (ragged rows are allowed, see index.rs) — the
/// frontend already knows the field count of any row it has rendered, so
/// column-only navigation is handled client-side without an IPC round trip.
#[tauri::command]
pub fn goto(row: usize, state: State<AppState>) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.as_ref().ok_or_else(|| "no file open".to_string())?;
    let row_count = open_file.index.row_count();
    if row >= row_count {
        return Err(format!("row {row} out of range (0..{row_count})"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, content: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("gigagrid_cmd_test_{}_{}.csv", name, std::process::id()));
        let mut f = File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn get_rows_returns_requested_window() {
        let path = write_temp("get_rows", "a,b\n1,2\n3,4\n5,6\n");
        let index = CsvIndex::build(&path).unwrap();
        let open_file = OpenFile { path: path.clone(), index, overlay: Overlay::new() };

        let rows = get_rows_impl(&open_file, 1, 2).unwrap();
        assert_eq!(rows, vec![vec!["1", "2"], vec!["3", "4"]]);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn get_rows_clips_to_row_count() {
        let path = write_temp("get_rows_clip", "a,b\n1,2\n");
        let index = CsvIndex::build(&path).unwrap();
        let open_file = OpenFile { path: path.clone(), index, overlay: Overlay::new() };

        let rows = get_rows_impl(&open_file, 0, 100).unwrap();
        assert_eq!(rows.len(), 2);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn get_rows_prefers_overlay_over_raw_value() {
        let path = write_temp("get_rows_overlay", "a,b\n1,2\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut overlay = Overlay::new();
        overlay.set(1, 0, "EDITED".to_string());
        let open_file = OpenFile { path: path.clone(), index, overlay };

        let rows = get_rows_impl(&open_file, 0, 2).unwrap();
        assert_eq!(rows[1][0], "EDITED");
        assert_eq!(rows[1][1], "2");
        assert_eq!(rows[0][0], "a");

        std::fs::remove_file(&path).ok();
    }
}
