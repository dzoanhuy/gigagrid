use crate::index::CsvIndex;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// Currently open file: the index (read-only over the raw file) plus the
/// path so a read command can (re)open the underlying `File` handle.
pub struct OpenFile {
    pub path: PathBuf,
    pub index: CsvIndex,
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
    *guard = Some(OpenFile { path: p, index });
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
/// a running app is impractical).
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
        rows.push(
            open_file
                .index
                .read_row(&mut file, r)
                .map_err(|e| e.to_string())?,
        );
    }
    Ok(rows)
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
        let open_file = OpenFile { path: path.clone(), index };

        let rows = get_rows_impl(&open_file, 1, 2).unwrap();
        assert_eq!(rows, vec![vec!["1", "2"], vec!["3", "4"]]);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn get_rows_clips_to_row_count() {
        let path = write_temp("get_rows_clip", "a,b\n1,2\n");
        let index = CsvIndex::build(&path).unwrap();
        let open_file = OpenFile { path: path.clone(), index };

        let rows = get_rows_impl(&open_file, 0, 100).unwrap();
        assert_eq!(rows.len(), 2);

        std::fs::remove_file(&path).ok();
    }
}
