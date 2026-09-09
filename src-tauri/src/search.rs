use crate::index::CsvIndex;
use crate::overlay::Overlay;
use std::fs::File;

/// Scan forward starting AFTER `from_row` (wrapping to 0), reusing
/// `CsvIndex::read_row` directly — no separate file handle or buffer.
pub fn find_next(index: &CsvIndex, file: &mut File, query: &str, from_row: usize) -> Option<usize> {
    let row_count = index.row_count();
    if row_count == 0 || query.is_empty() {
        return None;
    }
    for offset in 0..row_count {
        let r = (from_row + 1 + offset) % row_count;
        if let Ok(row) = index.read_row(file, r) {
            if row.iter().any(|cell| cell.contains(query)) {
                return Some(r);
            }
        }
    }
    None
}

/// Scan backward starting BEFORE `from_row` (wrapping to the last row).
pub fn find_prev(index: &CsvIndex, file: &mut File, query: &str, from_row: usize) -> Option<usize> {
    let row_count = index.row_count();
    if row_count == 0 || query.is_empty() {
        return None;
    }
    for offset in 0..row_count {
        let r = (from_row + row_count - 1 - offset) % row_count;
        if let Ok(row) = index.read_row(file, r) {
            if row.iter().any(|cell| cell.contains(query)) {
                return Some(r);
            }
        }
    }
    None
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
        // start search from the last row -> should wrap and find row 1
        assert_eq!(find_next(&index, &mut file, "needle", 2), Some(1));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn find_prev_wraps_around() {
        let path = write_temp("find_prev_wrap", "needle,b\nc,d\ne,f\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        // start search from row 0 backward -> should wrap and find row 0 itself
        assert_eq!(find_prev(&index, &mut file, "needle", 0), Some(0));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn no_match_returns_none() {
        let path = write_temp("no_match", "a,b\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        assert_eq!(find_next(&index, &mut file, "zzz", 0), None);
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
