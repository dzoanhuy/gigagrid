use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const CHUNK_SIZE: usize = 8 * 1024 * 1024;

/// Byte-offset index over a raw CSV file: `offsets[i]` is the start byte of
/// row `i`; the final entry is the file length (sentinel), so
/// `offsets.len() - 1` is the row count. Building never reads the whole file
/// into memory at once (fixed-size chunked scan); reading a row costs one
/// seek + one bounded read.
pub struct CsvIndex {
    offsets: Vec<u64>,
}

impl CsvIndex {
    pub fn row_count(&self) -> usize {
        self.offsets.len().saturating_sub(1)
    }

    /// Single forward scan. `in_quotes` toggles on every raw `"` byte —
    /// an escaped `""` inside a quoted field toggles twice and cancels out,
    /// so this correctly tracks quote state across chunk boundaries without
    /// needing to peek at the next byte.
    pub fn build(path: &Path) -> io::Result<CsvIndex> {
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

        Ok(CsvIndex { offsets })
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

        Ok(parse_csv_line(&buf))
    }
}

fn parse_csv_line(bytes: &[u8]) -> Vec<String> {
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
        } else {
            match b {
                b'"' => {
                    in_quotes = true;
                    i += 1;
                }
                b',' => {
                    fields.push(String::from_utf8_lossy(&field).into_owned());
                    field.clear();
                    i += 1;
                }
                b'\r' => {
                    i += 1;
                }
                _ => {
                    field.push(b);
                    i += 1;
                }
            }
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
