use crate::index::CsvIndex;
use crate::overlay::Overlay;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

/// Streams the CURRENT logical row order (via `overlay.read_logical_row` —
/// never through any active sort/filter view/permutation, and reflecting
/// every inserted/deleted row/column), writing each row to `dst`. Never
/// builds the whole output in memory — save speed is explicitly the lowest
/// priority (see plan.md), but correctness of WHICH row an edit lands on
/// is not negotiable (this phase's Risk).
pub fn save(index: &CsvIndex, overlay: &Overlay, src: &Path, dst: &Path) -> io::Result<()> {
    let mut src_file = File::open(src)?;
    let dst_file = File::create(dst)?;
    let mut writer = BufWriter::new(dst_file);
    let delimiter = index.delimiter();

    for r in 0..overlay.row_count() {
        let row = overlay.read_logical_row(index, &mut src_file, r)?;
        writeln!(writer, "{}", encode_csv_row(&row, delimiter))?;
    }
    writer.flush()
}

/// Re-encodes using the SAME delimiter the file was opened with (`index`
/// sniffs it once at open time) — saving a TSV file must produce TSV back,
/// not silently rewrite it as comma-separated.
fn encode_csv_row(fields: &[String], delimiter: u8) -> String {
    fields
        .iter()
        .map(|f| encode_csv_field(f, delimiter))
        .collect::<Vec<_>>()
        .join(std::str::from_utf8(&[delimiter]).unwrap())
}

fn encode_csv_field(field: &str, delimiter: u8) -> String {
    let delim_char = delimiter as char;
    if field.contains(delim_char) || field.contains('"') || field.contains('\n') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("gigagrid_save_test_{}_{}.csv", name, std::process::id()));
        let mut f = File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    fn temp_dst(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("gigagrid_save_test_dst_{}_{}.csv", name, std::process::id()));
        path
    }

    #[test]
    fn save_applies_overlay_and_preserves_unedited_rows() {
        let src = write_temp("roundtrip_src", "a,b\n1,2\n3,4\n");
        let dst = temp_dst("roundtrip");

        let index = CsvIndex::build(&src).unwrap();
        let mut overlay = Overlay::new(3, 2);
        overlay.set(1, 0, "EDITED".to_string());

        save(&index, &overlay, &src, &dst).unwrap();

        let saved = std::fs::read_to_string(&dst).unwrap();
        assert_eq!(saved, "a,b\nEDITED,2\n3,4\n");

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }

    #[test]
    fn save_round_trips_quoted_fields() {
        let src = write_temp("quote_src", "a,b\n\"has, comma\",plain\n");
        let dst = temp_dst("quote");

        let index = CsvIndex::build(&src).unwrap();
        let overlay = Overlay::new(2, 2);
        save(&index, &overlay, &src, &dst).unwrap();

        // Re-read the SAVED file through our own parser to confirm it round-
        // trips correctly, rather than eyeballing raw quote characters.
        let out_index = CsvIndex::build(&dst).unwrap();
        let mut out_file = File::open(&dst).unwrap();
        assert_eq!(
            out_index.read_row(&mut out_file, 1).unwrap(),
            vec!["has, comma", "plain"]
        );

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }

    #[test]
    fn save_preserves_original_row_order_regardless_of_any_view() {
        // save() takes no view/permutation argument at all — it always
        // streams 0..row_count from the index, so there is no way to
        // accidentally save in sorted/filtered order (this phase's Risk).
        let src = write_temp("order_src", "c\na\nb\n");
        let dst = temp_dst("order");

        let index = CsvIndex::build(&src).unwrap();
        let overlay = Overlay::new(3, 1);
        save(&index, &overlay, &src, &dst).unwrap();

        let saved = std::fs::read_to_string(&dst).unwrap();
        assert_eq!(saved, "c\na\nb\n");

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }

    #[test]
    fn save_round_trips_tab_delimited_file_as_tsv_not_csv() {
        let src = write_temp("tsv_src", "a\tb\n1\t2\n");
        let dst = temp_dst("tsv");

        let index = CsvIndex::build(&src).unwrap();
        assert_eq!(index.format_label(), "TSV");
        let mut overlay = Overlay::new(2, 2);
        overlay.set(1, 0, "EDITED".to_string());

        save(&index, &overlay, &src, &dst).unwrap();

        let saved = std::fs::read_to_string(&dst).unwrap();
        assert_eq!(saved, "a\tb\nEDITED\t2\n");

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }

    #[test]
    fn save_reflects_inserted_and_deleted_rows_and_columns() {
        let src = write_temp("structural_src", "a,b,c\nd,e,f\ng,h,i\n");
        let dst = temp_dst("structural");

        let index = CsvIndex::build(&src).unwrap();
        let mut overlay = Overlay::new(3, 3);
        overlay.delete_row(1).unwrap(); // remove "d,e,f"
        overlay.insert_row(2); // append a new blank row at the end
        overlay.set(2, 0, "NEW".to_string());
        overlay.delete_col(1).unwrap(); // remove column "b"/"h"/(new row's blank)

        save(&index, &overlay, &src, &dst).unwrap();

        let saved = std::fs::read_to_string(&dst).unwrap();
        assert_eq!(saved, "a,c\ng,i\nNEW,\n");

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }
}
