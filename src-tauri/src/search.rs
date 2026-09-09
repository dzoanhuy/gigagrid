use crate::index::CsvIndex;
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
}
