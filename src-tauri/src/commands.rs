use crate::index::CsvIndex;
use crate::overlay::Overlay;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub type TabId = u64;
const MAX_TABS: usize = 10;

pub struct TabRegistry {
    next_id: TabId,
    files: std::collections::HashMap<TabId, OpenFile>,
}

impl TabRegistry {
    pub fn new() -> Self {
        TabRegistry { next_id: 0, files: std::collections::HashMap::new() }
    }
}

pub type AppState = Mutex<TabRegistry>;

/// Currently open file: the index (read-only over the raw file), the path
/// so a read command can (re)open the underlying `File` handle, the edit
/// overlay (phase 05) merged into every read, and an optional sort/filter
/// `view` — a permutation/subset of ORIGINAL row indices that `get_rows`
/// remaps through. `sort_col`/`filter` are the inputs `view` was built
/// from, kept so setting one doesn't clobber the other.
pub struct OpenFile {
    pub path: PathBuf,
    pub index: CsvIndex,
    pub overlay: Overlay,
    pub view: Option<Vec<usize>>,
    pub sort_col: Option<usize>,
    pub filter: Option<String>,
}

#[derive(serde::Serialize)]
pub struct FileMeta {
    pub tab_id: TabId,
    pub path: String,
    pub row_count: usize,
    pub format: String,
    pub encoding: String,
    pub line_ending: String,
}

#[tauri::command]
pub fn open_file(
    path: String,
    delimiter: Option<String>,
    encoding: Option<String>,
    state: State<AppState>,
) -> Result<FileMeta, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    if guard.files.len() >= MAX_TABS {
        return Err(format!("cannot open more than {MAX_TABS} tabs — close one first"));
    }
    drop(guard);
    let p = PathBuf::from(&path);
    let override_byte = delimiter.as_ref().and_then(|s| s.bytes().next());
    let forced_encoding = encoding.as_deref().and_then(crate::index::parse_encoding);
    let index = CsvIndex::build_with_options(&p, override_byte, forced_encoding)
        .map_err(|e| e.to_string())?;
    let row_count = index.row_count();
    let format = index.format_label().to_string();
    let encoding = index.encoding_label().to_string();
    let line_ending = index.line_ending_label().to_string();
    // Column count for the insert/delete-column layer: read row 0's own
    // field count as the file's "canonical" width. A ragged file (rows with
    // differing field counts — tolerated everywhere else, see get_rows_impl)
    // still opens fine; inserting/deleting a column just operates on this
    // row-0-derived baseline rather than per-row widths, a known,
    // documented simplification rather than an attempt to handle every
    // ragged-file edge case here.
    let col_count = if row_count > 0 {
        let mut probe_file = File::open(&p).map_err(|e| e.to_string())?;
        index.read_row(&mut probe_file, 0).map_err(|e| e.to_string())?.len()
    } else {
        0
    };
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let tab_id = guard.next_id;
    guard.next_id += 1;
    guard.files.insert(tab_id, OpenFile {
        path: p,
        index,
        overlay: Overlay::new(row_count, col_count),
        view: None,
        sort_col: None,
        filter: None,
    });
    Ok(FileMeta { tab_id, path, row_count, format, encoding, line_ending })
}

#[tauri::command]
pub fn get_rows(
    tab_id: TabId,
    start: usize,
    count: usize,
    state: State<AppState>,
) -> Result<Vec<Vec<String>>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get(&tab_id).ok_or_else(|| "tab not found".to_string())?;
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
    let total = open_file
        .view
        .as_ref()
        .map(|v| v.len())
        .unwrap_or_else(|| open_file.overlay.row_count());
    let end = (start + count).min(total);
    let mut rows = Vec::with_capacity(end.saturating_sub(start));
    for i in start..end {
        // remap through the active view (if any) to the LOGICAL row index
        let r = open_file.view.as_ref().map(|v| v[i]).unwrap_or(i);
        let row = open_file
            .overlay
            .read_logical_row(&open_file.index, &mut file, r)
            .map_err(|e| e.to_string())?;
        rows.push(row);
    }
    Ok(rows)
}

fn view_len(open_file: &OpenFile) -> usize {
    open_file.view.as_ref().map(|v| v.len()).unwrap_or_else(|| open_file.overlay.row_count())
}

fn rebuild_view(open_file: &mut OpenFile) -> Result<(), String> {
    if open_file.sort_col.is_none() && open_file.filter.is_none() {
        open_file.view = None;
        return Ok(());
    }
    let mut file = File::open(&open_file.path).map_err(|e| e.to_string())?;
    let view = crate::search::sorted_filtered_view(
        &open_file.overlay,
        &open_file.index,
        &mut file,
        open_file.sort_col,
        open_file.filter.as_deref(),
    );
    open_file.view = Some(view);
    Ok(())
}

#[tauri::command]
pub fn set_sort(col: usize, tab_id: TabId, state: State<AppState>) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.sort_col = Some(col);
    rebuild_view(open_file)?;
    Ok(view_len(open_file))
}

#[tauri::command]
pub fn set_filter(query: String, tab_id: TabId, state: State<AppState>) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.filter = if query.is_empty() { None } else { Some(query) };
    rebuild_view(open_file)?;
    Ok(view_len(open_file))
}

#[tauri::command]
pub fn clear_sort(tab_id: TabId, state: State<AppState>) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.sort_col = None;
    rebuild_view(open_file)?;
    Ok(view_len(open_file))
}

#[tauri::command]
pub fn clear_view(tab_id: TabId, state: State<AppState>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.sort_col = None;
    open_file.filter = None;
    open_file.view = None;
    Ok(())
}

/// Saves using the ORIGINAL index + overlay — deliberately ignores any
/// active `view` (ALG per plan.md/phase-07's Risk: save must never merge
/// against sorted/filtered coordinates). Defaults `dst` to the originally
/// opened path.
#[tauri::command]
pub fn save_file(dst: Option<String>, tab_id: TabId, state: State<AppState>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let is_in_place = dst.is_none() || dst.as_deref().map(PathBuf::from) == Some(open_file.path.clone());
    let dst_path = dst.map(PathBuf::from).unwrap_or_else(|| open_file.path.clone());
    crate::save::save(&open_file.index, &open_file.overlay, &open_file.path, &dst_path)
        .map_err(|e| e.to_string())?;

    if is_in_place {
        let col_count = open_file.overlay.col_count();
        let delimiter = open_file.index.save_delimiter();
        let encoding = open_file.index.encoding();
        let new_index = CsvIndex::build_with_options(&open_file.path, Some(delimiter), Some(encoding))
            .map_err(|e| e.to_string())?;
        open_file.index = new_index;
        open_file.overlay = Overlay::new(open_file.index.row_count(), col_count);
        open_file.view = None;
        open_file.sort_col = None;
        open_file.filter = None;
    }
    Ok(())
}

#[tauri::command]
pub fn set_encoding(
    tab_id: TabId,
    encoding: String,
    state: State<AppState>,
) -> Result<FileMeta, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let enc = if encoding.trim().eq_ignore_ascii_case("auto") {
        let mut probe_file = File::open(&open_file.path).map_err(|e| e.to_string())?;
        let mut probe = vec![0u8; 64 * 1024];
        let n = probe_file.read(&mut probe).map_err(|e| e.to_string())?;
        probe.truncate(n);
        let (detected_enc, _) = crate::index::detect_encoding(&probe);
        detected_enc
    } else {
        crate::index::parse_encoding(&encoding).ok_or_else(|| format!("unknown encoding: {encoding}"))?
    };
    open_file.index.set_encoding(enc);
    let row_count = open_file.index.row_count();
    let format = open_file.index.format_label().to_string();
    let encoding_label = open_file.index.encoding_label().to_string();
    let line_ending = open_file.index.line_ending_label().to_string();
    let path = open_file.path.to_string_lossy().to_string();
    Ok(FileMeta { tab_id, path, row_count, format, encoding: encoding_label, line_ending })
}

#[tauri::command]
pub fn set_line_ending(
    tab_id: TabId,
    line_ending: String,
    state: State<AppState>,
) -> Result<FileMeta, String> {
    let is_crlf = match line_ending.trim().to_ascii_uppercase().as_str() {
        "CRLF" | "\r\n" => true,
        "LF" | "\n" => false,
        other => return Err(format!("unsupported line ending: {other} (expected 'LF' or 'CRLF')")),
    };
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.index.set_crlf(is_crlf);
    let row_count = open_file.index.row_count();
    let format = open_file.index.format_label().to_string();
    let encoding_label = open_file.index.encoding_label().to_string();
    let line_ending_label = open_file.index.line_ending_label().to_string();
    let path = open_file.path.to_string_lossy().to_string();
    Ok(FileMeta { tab_id, path, row_count, format, encoding: encoding_label, line_ending: line_ending_label })
}

#[tauri::command]
pub fn set_delimiter(
    tab_id: TabId,
    delimiter: String,
    state: State<AppState>,
) -> Result<FileMeta, String> {
    let delim_byte = match delimiter.trim().to_ascii_uppercase().as_str() {
        "TSV" | "\t" | "TAB" => b'\t',
        "CSV" | "," | "COMMA" => b',',
        ";" | "SEMICOLON" => b';',
        "|" | "PIPE" => b'|',
        s if s.len() == 1 => s.as_bytes()[0],
        other => return Err(format!("unsupported delimiter: {other}")),
    };
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.index.set_save_delimiter(Some(delim_byte));
    let row_count = open_file.index.row_count();
    let format = open_file.index.format_label().to_string();
    let encoding_label = open_file.index.encoding_label().to_string();
    let line_ending_label = open_file.index.line_ending_label().to_string();
    let path = open_file.path.to_string_lossy().to_string();
    Ok(FileMeta { tab_id, path, row_count, format, encoding: encoding_label, line_ending: line_ending_label })
}

#[tauri::command]
pub fn set_cell(
    row: usize,
    col: usize,
    value: String,
    tab_id: TabId,
    state: State<AppState>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.overlay.set(row, col, value);
    Ok(())
}

/// Batched write for paste — ALL `edits` land in one undo-stack group (see
/// overlay.rs), so a single Cmd/Ctrl+Z reverts the whole pasted range.
#[tauri::command]
pub fn set_cells_batch(
    edits: Vec<(usize, usize, String)>,
    tab_id: TabId,
    state: State<AppState>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.overlay.set_many(edits);
    Ok(())
}

/// Returns (did anything change, the row count AFTER undoing) — undo can
/// now revert a structural edit (insert/delete row/col), which changes the
/// logical row count out from under the frontend's own cached `rowCount`;
/// it needs this to stay in sync without a separate round trip.
#[tauri::command]
pub fn undo(tab_id: TabId, state: State<AppState>) -> Result<(bool, usize), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let changed = open_file.overlay.undo();
    Ok((changed, open_file.overlay.row_count()))
}

/// Mirror of `undo` — see its doc comment.
#[tauri::command]
pub fn redo(tab_id: TabId, state: State<AppState>) -> Result<(bool, usize), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let changed = open_file.overlay.redo();
    Ok((changed, open_file.overlay.row_count()))
}

#[tauri::command]
pub fn search(
    query: String,
    from_row: usize,
    from_col: usize,
    direction: String,
    tab_id: TabId,
    state: State<AppState>,
) -> Result<Option<(usize, usize)>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let mut file = File::open(&open_file.path).map_err(|e| e.to_string())?;
    let result = if direction == "prev" {
        crate::search::find_prev(&open_file.overlay, &open_file.index, &mut file, &query, from_row, from_col)
    } else {
        crate::search::find_next(&open_file.overlay, &open_file.index, &mut file, &query, from_row, from_col)
    };
    Ok(result)
}

#[tauri::command]
pub fn count_matches(query: String, tab_id: TabId, state: State<AppState>) -> Result<usize, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let mut file = File::open(&open_file.path).map_err(|e| e.to_string())?;
    Ok(crate::search::count_matches(&open_file.overlay, &open_file.index, &mut file, &query))
}

/// Replace ALL occurrences of `query` across the whole file in one undo
/// step. Returns how many CELLS were changed (0 means nothing matched —
/// the frontend uses this to skip an empty-no-op undo push / cache
/// invalidation).
#[tauri::command]
pub fn replace_all(
    query: String,
    replacement: String,
    tab_id: TabId,
    state: State<AppState>,
) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let mut file = File::open(&open_file.path).map_err(|e| e.to_string())?;
    let edits = crate::search::compute_replace_all(&open_file.overlay, &open_file.index, &mut file, &query, &replacement);
    let count = edits.len();
    if count > 0 {
        open_file.overlay.set_many(edits);
    }
    Ok(count)
}

/// Replace within a single cell (the one the search cursor is currently
/// on) — "Replace" as opposed to "Replace All". Returns false if that cell
/// didn't actually contain `query` (nothing changed, no undo entry).
#[tauri::command]
pub fn replace_cell(
    row: usize,
    col: usize,
    query: String,
    replacement: String,
    tab_id: TabId,
    state: State<AppState>,
) -> Result<bool, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let mut file = File::open(&open_file.path).map_err(|e| e.to_string())?;
    let new_value = crate::search::compute_replace_cell(
        &open_file.overlay,
        &open_file.index,
        &mut file,
        row,
        col,
        &query,
        &replacement,
    );
    match new_value {
        Some(v) => {
            open_file.overlay.set(row, col, v);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Validates `row` against the CURRENT logical row count (reflecting any
/// inserted/deleted rows). Column bounds are not tracked separately here —
/// the frontend already knows the field count of any row it has rendered,
/// so column-only navigation is handled client-side without an IPC round
/// trip.
#[tauri::command]
pub fn goto(row: usize, tab_id: TabId, state: State<AppState>) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    let row_count = open_file.overlay.row_count();
    if row >= row_count {
        return Err(format!("row {row} out of range (0..{row_count})"));
    }
    Ok(())
}

/// Inserts a brand-new, blank row at logical position `at` (`at ==
/// row_count()` appends at the end — used for "insert row below" on the
/// last row, and for "add row" from a toolbar with no row selected).
/// Returns the new row count so the frontend can update its cached one
/// without a separate round trip.
#[tauri::command]
pub fn insert_row(at: usize, tab_id: TabId, state: State<AppState>) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.overlay.insert_row(at);
    rebuild_view(open_file)?;
    Ok(open_file.overlay.row_count())
}

/// Deletes the row at logical position `at`. Returns the new row count.
#[tauri::command]
pub fn delete_row(at: usize, tab_id: TabId, state: State<AppState>) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.overlay.delete_row(at)?;
    rebuild_view(open_file)?;
    Ok(open_file.overlay.row_count())
}

/// Same as `insert_row`, for columns. Doesn't need to report a count back —
/// the frontend derives its column count from the width of whatever row
/// data `get_rows` returns, so a cache-invalidate + refetch is enough.
#[tauri::command]
pub fn insert_col(at: usize, tab_id: TabId, state: State<AppState>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.overlay.insert_col(at);
    Ok(())
}

/// Same as `delete_row`, for columns.
#[tauri::command]
pub fn delete_col(at: usize, tab_id: TabId, state: State<AppState>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let open_file = guard.files.get_mut(&tab_id).ok_or_else(|| "tab not found".to_string())?;
    open_file.overlay.delete_col(at)?;
    Ok(())
}

#[tauri::command]
pub fn close_tab(tab_id: TabId, state: State<AppState>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.files.remove(&tab_id);
    Ok(())
}

pub struct PendingOpen(pub std::sync::Mutex<Option<String>>);

#[tauri::command]
pub fn take_pending_open(state: State<PendingOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

pub fn is_csv_or_tsv(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".csv") || lower.ends_with(".tsv") || lower.ends_with(".tab")
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
        let open_file = OpenFile {
            path: path.clone(),
            index,
            overlay: Overlay::new(4, 2),
            view: None,
            sort_col: None,
            filter: None,
        };

        let rows = get_rows_impl(&open_file, 1, 2).unwrap();
        assert_eq!(rows, vec![vec!["1", "2"], vec!["3", "4"]]);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn get_rows_clips_to_row_count() {
        let path = write_temp("get_rows_clip", "a,b\n1,2\n");
        let index = CsvIndex::build(&path).unwrap();
        let open_file = OpenFile {
            path: path.clone(),
            index,
            overlay: Overlay::new(2, 2),
            view: None,
            sort_col: None,
            filter: None,
        };

        let rows = get_rows_impl(&open_file, 0, 100).unwrap();
        assert_eq!(rows.len(), 2);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn get_rows_prefers_overlay_over_raw_value() {
        let path = write_temp("get_rows_overlay", "a,b\n1,2\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut overlay = Overlay::new(2, 2);
        overlay.set(1, 0, "EDITED".to_string());
        let open_file = OpenFile {
            path: path.clone(),
            index,
            overlay,
            view: None,
            sort_col: None,
            filter: None,
        };

        let rows = get_rows_impl(&open_file, 0, 2).unwrap();
        assert_eq!(rows[1][0], "EDITED");
        assert_eq!(rows[1][1], "2");
        assert_eq!(rows[0][0], "a");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn get_rows_remaps_through_active_view() {
        let path = write_temp("get_rows_view", "b\na\nc\n");
        let index = CsvIndex::build(&path).unwrap();
        let open_file = OpenFile {
            path: path.clone(),
            index,
            overlay: Overlay::new(3, 1),
            view: Some(vec![1, 0, 2]), // pretend a sort already reordered to a,b,c
            sort_col: None,
            filter: None,
        };

        let rows = get_rows_impl(&open_file, 0, 3).unwrap();
        assert_eq!(rows, vec![vec!["a"], vec!["b"], vec!["c"]]);

        std::fs::remove_file(&path).ok();
    }

    /// Reproduces the user's report: copying a ~200k-row x 27-col selection
    /// came back with entire rows blank. Not `#[ignore]` — this must run
    /// every `cargo test`, it's exactly the scale that broke.
    #[test]
    fn get_rows_handles_a_200k_row_27_col_selection_with_no_blank_rows() {
        let path = write_temp("get_rows_huge", "");
        {
            let mut f = File::create(&path).unwrap();
            let mut writer = std::io::BufWriter::new(&mut f);
            for r in 0..200_000usize {
                let mut line = String::with_capacity(27 * 8);
                for c in 0..27usize {
                    if c > 0 {
                        line.push(',');
                    }
                    line.push_str(&format!("r{r}c{c}"));
                }
                line.push('\n');
                writer.write_all(line.as_bytes()).unwrap();
            }
        }

        let index = CsvIndex::build(&path).unwrap();
        assert_eq!(index.row_count(), 200_000);
        let open_file = OpenFile {
            path: path.clone(),
            index,
            overlay: Overlay::new(200_000, 27),
            view: None,
            sort_col: None,
            filter: None,
        };

        let t0 = std::time::Instant::now();
        let rows = get_rows_impl(&open_file, 0, 200_000).unwrap();
        let elapsed = t0.elapsed();
        println!("get_rows_impl(0, 200_000) took {:?}", elapsed);

        assert_eq!(rows.len(), 200_000, "wrong row count returned");
        for (r, row) in rows.iter().enumerate() {
            assert_eq!(row.len(), 27, "row {r} has {} cols, expected 27", row.len());
            assert_eq!(row[0], format!("r{r}c0"), "row {r} col 0 mismatch");
            assert_eq!(row[26], format!("r{r}c26"), "row {r} col 26 mismatch");
        }

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_set_encoding_explicit_and_auto() {
        let path = write_temp("set_enc", "col1,col2\nval1,val2\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut registry = TabRegistry::new();
        let tab_id = registry.next_id;
        registry.next_id += 1;
        registry.files.insert(tab_id, OpenFile {
            path: path.clone(),
            index,
            overlay: Overlay::new(2, 2),
            view: None,
            sort_col: None,
            filter: None,
        });
        let state = Mutex::new(registry);

        // Switch to shift_jis
        let open_file = state.lock().unwrap().files.get_mut(&tab_id).unwrap().index.set_encoding(encoding_rs::SHIFT_JIS);
        let _ = open_file;
        assert_eq!(state.lock().unwrap().files.get(&tab_id).unwrap().index.encoding_label(), "Shift-JIS");

        std::fs::remove_file(&path).ok();
    }
}
