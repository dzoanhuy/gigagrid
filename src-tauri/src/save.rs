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
    let is_same_file = src == dst || std::fs::canonicalize(src).ok() == std::fs::canonicalize(dst).ok();
    let temp_dst_path;
    let actual_dst = if is_same_file {
        let file_name = dst.file_name().and_then(|n| n.to_str()).unwrap_or("tmp");
        let parent = dst.parent().unwrap_or_else(|| Path::new("."));
        temp_dst_path = parent.join(format!(".{}_{}.tmp", file_name, std::process::id()));
        &temp_dst_path
    } else {
        dst
    };

    let mut src_file = File::open(src)?;
    let dst_file = File::create(actual_dst)?;
    let mut writer = BufWriter::new(dst_file);
    let delimiter = index.save_delimiter();
    let encoding = index.encoding();
    let line_ending = if index.is_crlf() { "\r\n" } else { "\n" };

    if index.has_bom() && encoding == encoding_rs::UTF_8 {
        writer.write_all(&[0xEF, 0xBB, 0xBF])?;
    }

    for r in 0..overlay.row_count() {
        let row = overlay.read_logical_row(index, &mut src_file, r)?;
        let row_str = encode_csv_row(&row, delimiter);
        if encoding == encoding_rs::UTF_8 {
            writer.write_all(row_str.as_bytes())?;
        } else {
            let (encoded_bytes, _, _) = encoding.encode(&row_str);
            writer.write_all(&encoded_bytes)?;
        }
        writer.write_all(line_ending.as_bytes())?;
    }
    writer.flush()?;
    drop(writer);
    drop(src_file);

    if is_same_file {
        std::fs::rename(actual_dst, dst)?;
    }

    Ok(())
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

    #[test]
    fn save_preserves_shift_jis_encoding() {
        let text = "名前,年齢\n田中,30\n";
        let (sjis_bytes, _, _) = encoding_rs::SHIFT_JIS.encode(text);
        let mut src = std::env::temp_dir();
        src.push(format!("gigagrid_sjis_save_src_{}.csv", std::process::id()));
        std::fs::write(&src, sjis_bytes).unwrap();
        let dst = temp_dst("sjis_save");

        let index = CsvIndex::build(&src).unwrap();
        assert_eq!(index.encoding_label(), "Shift-JIS");
        let mut overlay = Overlay::new(2, 2);
        overlay.set(1, 0, "佐藤".to_string());
        save(&index, &overlay, &src, &dst).unwrap();

        // Read saved file back as Shift-JIS
        let out_idx = CsvIndex::build(&dst).unwrap();
        assert_eq!(out_idx.encoding_label(), "Shift-JIS");
        let mut out_file = File::open(&dst).unwrap();
        assert_eq!(out_idx.read_row(&mut out_file, 0).unwrap(), vec!["名前", "年齢"]);
        assert_eq!(out_idx.read_row(&mut out_file, 1).unwrap(), vec!["佐藤", "30"]);

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }

    #[test]
    fn save_switches_line_ending_between_lf_and_crlf() {
        let src = write_temp("le_src", "a,b\n1,2\n");
        let dst = temp_dst("le_crlf");

        let mut index = CsvIndex::build(&src).unwrap();
        assert_eq!(index.line_ending_label(), "LF");
        let overlay = Overlay::new(2, 2);

        // Switch to CRLF and save
        index.set_crlf(true);
        save(&index, &overlay, &src, &dst).unwrap();
        let bytes = std::fs::read(&dst).unwrap();
        assert_eq!(bytes, b"a,b\r\n1,2\r\n");

        // Now take the CRLF file and convert back to LF
        let dst_lf = temp_dst("le_lf");
        let mut crlf_index = CsvIndex::build(&dst).unwrap();
        assert_eq!(crlf_index.line_ending_label(), "CRLF");
        let crlf_overlay = Overlay::new(2, 2);
        crlf_index.set_crlf(false);
        save(&crlf_index, &crlf_overlay, &dst, &dst_lf).unwrap();
        let lf_bytes = std::fs::read(&dst_lf).unwrap();
        assert_eq!(lf_bytes, b"a,b\n1,2\n");

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
        std::fs::remove_file(&dst_lf).ok();
    }

    #[test]
    fn save_in_place_same_path_succeeds() {
        let path = write_temp("same_path", "a,b\n1,2\n");
        let mut index = CsvIndex::build(&path).unwrap();
        let mut overlay = Overlay::new(2, 2);
        overlay.set(1, 0, "EDITED".to_string());
        index.set_crlf(true);

        // Save directly to the same path
        save(&index, &overlay, &path, &path).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "a,b\r\nEDITED,2\r\n");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn save_converts_csv_to_tsv_and_tsv_to_csv() {
        let src_csv = write_temp("conv_csv", "name,age,city\nAlice,30,Tokyo\nBob,25,\"New York, NY\"\n");
        let dst_tsv = temp_dst("conv_tsv");

        let mut index = CsvIndex::build(&src_csv).unwrap();
        assert_eq!(index.format_label(), "CSV");
        let overlay = Overlay::new(3, 3);

        // Convert format to TSV
        index.set_save_delimiter(Some(b'\t'));
        assert_eq!(index.format_label(), "TSV");
        save(&index, &overlay, &src_csv, &dst_tsv).unwrap();

        // Check TSV content
        let tsv_text = std::fs::read_to_string(&dst_tsv).unwrap();
        assert_eq!(tsv_text, "name\tage\tcity\nAlice\t30\tTokyo\nBob\t25\tNew York, NY\n");

        // Now convert that TSV back to CSV
        let dst_csv2 = temp_dst("conv_csv2");
        let mut tsv_index = CsvIndex::build(&dst_tsv).unwrap();
        assert_eq!(tsv_index.format_label(), "TSV");
        let tsv_overlay = Overlay::new(3, 3);
        tsv_index.set_save_delimiter(Some(b','));
        assert_eq!(tsv_index.format_label(), "CSV");
        save(&tsv_index, &tsv_overlay, &dst_tsv, &dst_csv2).unwrap();

        let csv2_text = std::fs::read_to_string(&dst_csv2).unwrap();
        assert_eq!(csv2_text, "name,age,city\nAlice,30,Tokyo\nBob,25,\"New York, NY\"\n");

        std::fs::remove_file(&src_csv).ok();
        std::fs::remove_file(&dst_tsv).ok();
        std::fs::remove_file(&dst_csv2).ok();
    }
}

