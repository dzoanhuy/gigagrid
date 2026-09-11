use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const CHUNK_SIZE: usize = 8 * 1024 * 1024;

/// Byte-offset index over a raw CSV/TSV file: `offsets[i]` is the start byte
/// of row `i`; the final entry is the file length (sentinel), so
/// `offsets.len() - 1` is the row count. Building never reads the whole file
/// into memory at once (fixed-size chunked scan); reading a row costs one
/// seek + one bounded read. Delimiter/encoding(BOM)/line-ending are sniffed
/// ONCE at build time from the first row (bounded probe, not a full scan) —
/// display-only metadata, except delimiter which `read_row`/`save` also use
/// to actually split/join fields (round-tripping a TSV file as TSV, not
/// silently rewriting it as CSV).
pub struct CsvIndex {
    offsets: Vec<u64>,
    delimiter: u8,
    has_bom: bool,
    crlf: bool,
}

/// First-row probe cap for delimiter/line-ending sniffing — bounded so a
/// file with a pathologically long single line still detects in O(1) work,
/// not proportional to file size.
const SNIFF_CAP: usize = 64 * 1024;

impl CsvIndex {
    pub fn row_count(&self) -> usize {
        self.offsets.len().saturating_sub(1)
    }

    pub fn delimiter(&self) -> u8 {
        self.delimiter
    }

    pub fn format_label(&self) -> &'static str {
        if self.delimiter == b'\t' { "TSV" } else { "CSV" }
    }

    pub fn encoding_label(&self) -> &'static str {
        if self.has_bom { "UTF-8 (BOM)" } else { "UTF-8" }
    }

    pub fn line_ending_label(&self) -> &'static str {
        if self.crlf { "CRLF" } else { "LF" }
    }

    /// Single forward scan. `in_quotes` toggles on every raw `"` byte —
    /// an escaped `""` inside a quoted field toggles twice and cancels out,
    /// so this correctly tracks quote state across chunk boundaries without
    /// needing to peek at the next byte.
    pub fn build(path: &Path) -> io::Result<CsvIndex> {
        Self::build_inner(path, None)
    }

    pub fn build_with_delimiter(path: &Path, delimiter: u8) -> io::Result<CsvIndex> {
        Self::build_inner(path, Some(delimiter))
    }

    fn build_inner(path: &Path, forced_delimiter: Option<u8>) -> io::Result<CsvIndex> {
        let file = File::open(path)?;
        let file_len = file.metadata()?.len();
        let mut reader = BufReader::new(file);

        let mut offsets: Vec<u64> = vec![0];
        let mut in_quotes = false;
        let mut pos: u64 = 0;
        let mut buf = vec![0u8; CHUNK_SIZE];

        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            for (i, &b) in buf[..n].iter().enumerate() {
                if b == b'"' {
                    in_quotes = !in_quotes;
                } else if b == b'\n' && !in_quotes {
                    offsets.push(pos + i as u64 + 1);
                }
            }
            pos += n as u64;
        }

        if *offsets.last().unwrap() != file_len {
            offsets.push(file_len);
        }

        // Sniff BOM / delimiter / line-ending from a bounded probe of the
        // file's start — never proportional to file size.
        let mut has_bom = false;
        let mut delimiter = b',';
        let mut crlf = false;
        if file_len > 0 {
            let mut probe_file = File::open(path)?;
            let probe_len = (file_len as usize).min(SNIFF_CAP + 3);
            let mut probe = vec![0u8; probe_len];
            let n = probe_file.read(&mut probe)?;
            probe.truncate(n);

            if probe.len() >= 3 && probe[0..3] == [0xEF, 0xBB, 0xBF] {
                has_bom = true;
            }
            let bom_len: u64 = if has_bom { 3 } else { 0 };
            if has_bom && offsets[0] == 0 {
                offsets[0] = bom_len;
            }

            let row_end = offsets.get(1).copied().unwrap_or(file_len).min(probe.len() as u64);
            if row_end > bom_len {
                let line = &probe[bom_len as usize..row_end as usize];
                crlf = line.len() >= 2 && line[line.len() - 2] == b'\r' && line[line.len() - 1] == b'\n';
                if let Some(d) = forced_delimiter {
                    delimiter = d;
                } else {
                    let comma_count = line.iter().filter(|&&b| b == b',').count();
                    let tab_count = line.iter().filter(|&&b| b == b'\t').count();
                    let semicolon_count = line.iter().filter(|&&b| b == b';').count();
                    let pipe_count = line.iter().filter(|&&b| b == b'|').count();
                    let counts = [(b',', comma_count), (b'\t', tab_count), (b';', semicolon_count), (b'|', pipe_count)];
                    delimiter = counts.iter().copied().max_by_key(|&(_, c)| c).map(|(d, _)| d).unwrap_or(b',');
                }
            }
        }

        Ok(CsvIndex { offsets, delimiter, has_bom, crlf })
    }

    /// Seek to `offsets[row]`, read exactly the row's byte span, split into
    /// fields respecting quotes/escapes. Never touches any other part of
    /// the file.
    pub fn read_row(&self, file: &mut File, row: usize) -> io::Result<Vec<String>> {
        if row + 1 >= self.offsets.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "row out of range"));
        }
        let start = self.offsets[row];
        let end = self.offsets[row + 1];
        let len = (end - start) as usize;
        let mut buf = vec![0u8; len];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buf)?;

        while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
            buf.pop();
        }

        Ok(parse_csv_line(&buf, self.delimiter))
    }
}

fn parse_csv_line(bytes: &[u8], delimiter: u8) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field: Vec<u8> = Vec::new();
    let mut in_quotes = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if in_quotes {
            if b == b'"' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                    field.push(b'"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
                i += 1;
                continue;
            }
            field.push(b);
            i += 1;
        } else if b == b'"' {
            in_quotes = true;
            i += 1;
        } else if b == delimiter {
            fields.push(String::from_utf8_lossy(&field).into_owned());
            field.clear();
            i += 1;
        } else if b == b'\r' {
            i += 1;
        } else {
            field.push(b);
            i += 1;
        }
    }
    fields.push(String::from_utf8_lossy(&field).into_owned());
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("gigagrid_test_{}_{}.csv", name, std::process::id()));
        let mut f = File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn no_quotes() {
        let path = write_temp("no_quotes", "a,b,c\n1,2,3\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.row_count(), 2);
        let mut file = File::open(&path).unwrap();
        assert_eq!(idx.read_row(&mut file, 0).unwrap(), vec!["a", "b", "c"]);
        assert_eq!(idx.read_row(&mut file, 1).unwrap(), vec!["1", "2", "3"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn comma_in_quotes() {
        let path = write_temp("comma_in_quotes", "a,\"b,c\",d\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.row_count(), 1);
        let mut file = File::open(&path).unwrap();
        assert_eq!(idx.read_row(&mut file, 0).unwrap(), vec!["a", "b,c", "d"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn newline_in_quotes() {
        let path = write_temp("newline_in_quotes", "a,\"line1\nline2\",c\nd,e,f\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.row_count(), 2);
        let mut file = File::open(&path).unwrap();
        assert_eq!(
            idx.read_row(&mut file, 0).unwrap(),
            vec!["a", "line1\nline2", "c"]
        );
        assert_eq!(idx.read_row(&mut file, 1).unwrap(), vec!["d", "e", "f"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn escaped_quote() {
        let path = write_temp("escaped_quote", "a,\"she said \"\"hi\"\"\",c\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.row_count(), 1);
        let mut file = File::open(&path).unwrap();
        assert_eq!(
            idx.read_row(&mut file, 0).unwrap(),
            vec!["a", "she said \"hi\"", "c"]
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn no_trailing_newline() {
        let path = write_temp("no_trailing_newline", "a,b\nc,d");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.row_count(), 2);
        let mut file = File::open(&path).unwrap();
        assert_eq!(idx.read_row(&mut file, 1).unwrap(), vec!["c", "d"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn detects_comma_by_default() {
        let path = write_temp("detect_comma", "a,b,c\n1,2,3\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.format_label(), "CSV");
        assert_eq!(idx.delimiter(), b',');
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn detects_tab_delimited_and_parses_as_tsv() {
        let path = write_temp("detect_tab", "a\tb\tc\n1\t2\t3\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.format_label(), "TSV");
        assert_eq!(idx.delimiter(), b'\t');
        let mut file = File::open(&path).unwrap();
        assert_eq!(idx.read_row(&mut file, 1).unwrap(), vec!["1", "2", "3"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn detects_crlf_line_ending() {
        let path = write_temp("detect_crlf", "a,b\r\nc,d\r\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.line_ending_label(), "CRLF");
        let mut file = File::open(&path).unwrap();
        // \r must not leak into the field content
        assert_eq!(idx.read_row(&mut file, 0).unwrap(), vec!["a", "b"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn detects_lf_line_ending() {
        let path = write_temp("detect_lf", "a,b\nc,d\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.line_ending_label(), "LF");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn strips_utf8_bom_from_first_field() {
        let path = write_temp("detect_bom", "\u{FEFF}a,b\n1,2\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.encoding_label(), "UTF-8 (BOM)");
        let mut file = File::open(&path).unwrap();
        // the BOM bytes must not leak into row 0's first field
        assert_eq!(idx.read_row(&mut file, 0).unwrap(), vec!["a", "b"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn no_bom_reports_plain_utf8() {
        let path = write_temp("detect_no_bom", "a,b\n1,2\n");
        let idx = CsvIndex::build(&path).unwrap();
        assert_eq!(idx.encoding_label(), "UTF-8");
        std::fs::remove_file(&path).ok();
    }

    /// Not part of the regular suite — generates a ~1GB synthetic CSV and
    /// times `build()` + a random-access `read_row`. Run manually:
    /// `cargo test index::tests::bench_1gb -- --ignored --nocapture`
    /// (wrap with `/usr/bin/time -l` on macOS to see peak RSS).
    #[test]
    #[ignore]
    fn bench_1gb() {
        let mut path = std::env::temp_dir();
        path.push(format!("gigagrid_bench_{}.csv", std::process::id()));
        {
            let mut f = File::create(&path).unwrap();
            let row = "field_a,field_b,\"quoted, field with comma\",field_d,field_e\n";
            let target_bytes: u64 = 1_073_741_824;
            let mut written: u64 = 0;
            let mut buf_writer = io::BufWriter::new(&mut f);
            while written < target_bytes {
                buf_writer.write_all(row.as_bytes()).unwrap();
                written += row.len() as u64;
            }
        }

        let t0 = std::time::Instant::now();
        let idx = CsvIndex::build(&path).unwrap();
        let build_elapsed = t0.elapsed();
        println!(
            "build(): {} rows in {:?} ({} bytes)",
            idx.row_count(),
            build_elapsed,
            path.metadata().unwrap().len()
        );

        let mut file = File::open(&path).unwrap();
        let t1 = std::time::Instant::now();
        let row = idx.read_row(&mut file, idx.row_count() / 2).unwrap();
        println!("read_row(mid): {:?} -> {:?}", t1.elapsed(), row);

        std::fs::remove_file(&path).ok();
    }
}
