use crate::index::CsvIndex;
use crate::overlay::Overlay;
use std::fs::File;

/// Scan forward cell-by-cell starting AFTER `(from_row, from_col)` in
/// row-major order, wrapping around the whole file — returns the exact
/// `(row, col)` of the next match so the frontend can SELECT that cell, not
/// just scroll to its row. Falls back to re-checking `from_row`'s own
/// columns up to and including `from_col` (the one range the main wrap-
/// around loop never revisits, since it starts back at `from_row` only via
/// `offset == 0`, at `from_col + 1`) so a lone match keeps re-selecting
/// itself on repeated "next" instead of vanishing.
pub fn find_next(
    index: &CsvIndex,
    file: &mut File,
    query: &str,
    from_row: usize,
    from_col: usize,
) -> Option<(usize, usize)> {
    let row_count = index.row_count();
    if row_count == 0 || query.is_empty() {
        return None;
    }
    for offset in 0..row_count {
        let r = (from_row + offset) % row_count;
        if let Ok(row) = index.read_row(file, r) {
            let start_col = if offset == 0 { from_col + 1 } else { 0 };
            for (c, cell) in row.iter().enumerate().skip(start_col) {
                if cell.contains(query) {
                    return Some((r, c));
                }
            }
        }
    }
    if let Ok(row) = index.read_row(file, from_row) {
        for (c, cell) in row.iter().enumerate() {
            if c > from_col {
                break;
            }
            if cell.contains(query) {
                return Some((from_row, c));
            }
        }
    }
    None
}

/// Mirror of `find_next`, scanning backward from BEFORE `(from_row,
/// from_col)`.
pub fn find_prev(
    index: &CsvIndex,
    file: &mut File,
    query: &str,
    from_row: usize,
    from_col: usize,
) -> Option<(usize, usize)> {
    let row_count = index.row_count();
    if row_count == 0 || query.is_empty() {
        return None;
    }
    for offset in 0..row_count {
        let r = (from_row + row_count - offset) % row_count;
        if let Ok(row) = index.read_row(file, r) {
            let upper = if offset == 0 { from_col } else { row.len() };
            for c in (0..upper.min(row.len())).rev() {
                if row[c].contains(query) {
                    return Some((r, c));
                }
            }
        }
    }
    if let Ok(row) = index.read_row(file, from_row) {
        for c in (from_col..row.len()).rev() {
            if row[c].contains(query) {
                return Some((from_row, c));
            }
        }
    }
    None
}

/// Full scan counting every matching CELL (not row) across the whole
/// file — same order of cost as one `find_next` sweep, run once per query
/// change (debounced on the frontend), not on every fetch.
pub fn count_matches(index: &CsvIndex, file: &mut File, query: &str) -> usize {
    let row_count = index.row_count();
    if row_count == 0 || query.is_empty() {
        return 0;
    }
    let mut count = 0;
    for r in 0..row_count {
        if let Ok(row) = index.read_row(file, r) {
            count += row.iter().filter(|cell| cell.contains(query)).count();
        }
    }
    count
}

/// Computes every cell edit needed to replace ALL occurrences of `query`
/// with `replacement` in every cell that contains it, across the WHOLE
/// file — same "read through the overlay first" rule as every other read
/// path (a cell already edited gets replaced against its CURRENT value,
/// not the stale raw one). Doesn't mutate anything; the caller applies the
/// result via `Overlay::set_many` so the whole replace-all lands in ONE
/// undo group, same as a paste.
pub fn compute_replace_all(
    index: &CsvIndex,
    file: &mut File,
    overlay: &Overlay,
    query: &str,
    replacement: &str,
) -> Vec<(usize, usize, String)> {
    let mut edits = Vec::new();
    if query.is_empty() {
        return edits;
    }
    let row_count = index.row_count();
    for r in 0..row_count {
        if let Ok(row) = index.read_row(file, r) {
            for c in 0..row.len() {
                let current = overlay.get(r, c).cloned().unwrap_or_else(|| row[c].clone());
                if current.contains(query) {
                    edits.push((r, c, current.replace(query, replacement)));
                }
            }
        }
    }
    edits
}

/// Same replace, scoped to a single cell — used by "Replace" (as opposed to
/// "Replace All") on whatever cell the search cursor currently sits on.
/// Returns `None` if the cell doesn't actually contain `query` (nothing to
/// do) so the caller doesn't push a no-op undo entry.
pub fn compute_replace_cell(
    index: &CsvIndex,
    file: &mut File,
    overlay: &Overlay,
    row: usize,
    col: usize,
    query: &str,
    replacement: &str,
) -> Option<String> {
    if query.is_empty() {
        return None;
    }
    let raw = index.read_row(file, row).ok()?.get(col)?.clone();
    let current = overlay.get(row, col).cloned().unwrap_or(raw);
    if !current.contains(query) {
        return None;
    }
    Some(current.replace(query, replacement))
}

/// Returns ORIGINAL row indices in the desired display order/subset — a
/// permutation (or filtered subset), never a data copy. Values are read
/// through the overlay merge, so an edited cell is what gets sorted/
/// filtered on, not the stale raw value. (Signature takes `file: &mut
/// File` in addition to the plan's listed params — reading row contents
/// to sort/filter needs it, same as find_next/find_prev above.)
pub fn sorted_filtered_view(
    index: &CsvIndex,
    file: &mut File,
    overlay: &Overlay,
    sort_col: Option<usize>,
    filter: Option<&str>,
) -> Vec<usize> {
    let row_count = index.row_count();
    let mut rows: Vec<usize> = (0..row_count).collect();

    if let Some(needle) = filter {
        if !needle.is_empty() {
            rows.retain(|&r| {
                index
                    .read_row(file, r)
                    .map(|row| {
                        row.iter().enumerate().any(|(c, cell)| {
                            let value = overlay.get(r, c).cloned().unwrap_or_else(|| cell.clone());
                            value.contains(needle)
                        })
                    })
                    .unwrap_or(false)
            });
        }
    }

    if let Some(col) = sort_col {
        let mut keyed: Vec<(usize, String)> = rows
            .into_iter()
            .map(|r| {
                let raw = index
                    .read_row(file, r)
                    .ok()
                    .and_then(|row| row.get(col).cloned())
                    .unwrap_or_default();
                let value = overlay.get(r, col).cloned().unwrap_or(raw);
                (r, value)
            })
            .collect();
        keyed.sort_by(|a, b| a.1.cmp(&b.1));
        rows = keyed.into_iter().map(|(r, _)| r).collect();
    }

    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("gigagrid_search_test_{}_{}.csv", name, std::process::id()));
        let mut f = File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn find_next_wraps_around() {
        let path = write_temp("find_next_wrap", "a,b\nc,needle\ne,f\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        // start search from the last row -> should wrap and find row 1, col 1
        assert_eq!(find_next(&index, &mut file, "needle", 2, 0), Some((1, 1)));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn find_next_advances_within_the_same_row() {
        let path = write_temp("find_next_same_row", "needle,needle,x\na,b,c\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        // anchored at (0,0) (the first match) -> next should be (0,1), the
        // SECOND match in the same row, not skip ahead to another row
        assert_eq!(find_next(&index, &mut file, "needle", 0, 0), Some((0, 1)));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn find_next_lone_match_keeps_reselecting_itself() {
        let path = write_temp("find_next_lone", "a,needle\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        // anchored exactly ON the only match -> pressing "next" again wraps
        // all the way around and must land back on it, not return None
        assert_eq!(find_next(&index, &mut file, "needle", 0, 1), Some((0, 1)));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn find_prev_wraps_around() {
        let path = write_temp("find_prev_wrap", "needle,b\nc,d\ne,f\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        // start search from row 0 backward -> should wrap and find row 0 itself
        assert_eq!(find_prev(&index, &mut file, "needle", 0, 0), Some((0, 0)));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn no_match_returns_none() {
        let path = write_temp("no_match", "a,b\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        assert_eq!(find_next(&index, &mut file, "zzz", 0, 0), None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn count_matches_counts_every_matching_cell() {
        let path = write_temp("count_matches", "needle,x\nneedle,needle\ny,z\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        assert_eq!(count_matches(&index, &mut file, "needle"), 3);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn count_matches_empty_query_is_zero() {
        let path = write_temp("count_matches_empty", "a,b\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        assert_eq!(count_matches(&index, &mut file, ""), 0);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn compute_replace_all_finds_every_matching_cell_across_the_file() {
        let path = write_temp("replace_all", "foo,x\nbarfoo,foobar\ny,z\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let overlay = Overlay::new();
        let mut edits = compute_replace_all(&index, &mut file, &overlay, "foo", "QUX");
        edits.sort();
        assert_eq!(
            edits,
            vec![
                (0, 0, "QUX".to_string()),
                (1, 0, "barQUX".to_string()),
                (1, 1, "QUXbar".to_string()),
            ]
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn compute_replace_all_reads_through_overlay_not_stale_raw_value() {
        let path = write_temp("replace_all_overlay", "raw,x\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new();
        overlay.set(0, 0, "editedfoo".to_string());
        let edits = compute_replace_all(&index, &mut file, &overlay, "foo", "bar");
        assert_eq!(edits, vec![(0, 0, "editedbar".to_string())]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn compute_replace_all_empty_query_replaces_nothing() {
        let path = write_temp("replace_all_empty", "a,b\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let overlay = Overlay::new();
        assert_eq!(compute_replace_all(&index, &mut file, &overlay, "", "x"), Vec::new());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn compute_replace_cell_replaces_all_occurrences_within_that_one_cell() {
        let path = write_temp("replace_cell", "foofoo,other\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let overlay = Overlay::new();
        let result = compute_replace_cell(&index, &mut file, &overlay, 0, 0, "foo", "bar");
        assert_eq!(result, Some("barbar".to_string()));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn compute_replace_cell_none_when_cell_has_no_match() {
        let path = write_temp("replace_cell_none", "a,b\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let overlay = Overlay::new();
        assert_eq!(compute_replace_cell(&index, &mut file, &overlay, 0, 0, "zzz", "y"), None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn sorted_filtered_view_sorts_by_column() {
        let path = write_temp("view_sort", "c,3\na,1\nb,2\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let overlay = Overlay::new();
        let view = sorted_filtered_view(&index, &mut file, &overlay, Some(0), None);
        // original rows: 0="c,3" 1="a,1" 2="b,2" -> sorted by col 0 -> a,b,c -> rows 1,2,0
        assert_eq!(view, vec![1, 2, 0]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn sorted_filtered_view_filters_subset() {
        let path = write_temp("view_filter", "apple,1\nbanana,2\navocado,3\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let overlay = Overlay::new();
        let view = sorted_filtered_view(&index, &mut file, &overlay, None, Some("av"));
        assert_eq!(view, vec![2]); // only "avocado" (row 2) contains "av" besides row 0? "apple" has no "av"
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn sorted_filtered_view_reads_through_overlay() {
        let path = write_temp("view_overlay", "z,1\ny,2\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new();
        overlay.set(0, 0, "a".to_string()); // row 0 was "z", now overlay says "a"
        let view = sorted_filtered_view(&index, &mut file, &overlay, Some(0), None);
        // sorted by overlay-merged col 0: "a" (row 0), "y" (row 1) -> [0, 1]
        assert_eq!(view, vec![0, 1]);
        std::fs::remove_file(&path).ok();
    }
}
