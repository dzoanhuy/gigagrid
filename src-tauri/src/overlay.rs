use crate::index::CsvIndex;
use std::collections::HashMap;
use std::fs::File;
use std::io;

/// Where a LOGICAL row currently gets its data from: a row that existed in
/// the original file (identified by its ORIGINAL index, permanent — never
/// reassigned even as rows around it are inserted/deleted), or a row the
/// user inserted (identified by a permanent id, never reused). This is the
/// STABLE identity every cell edit is keyed against — `row_order`'s
/// position for a given row can shift on every insert/delete, but its
/// `RowKey` never does, so an edit never silently "jumps" to a different
/// row after a structural change elsewhere in the file.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum RowKey {
    Original(usize),
    New(u64),
}

/// Same idea as `RowKey`, for columns.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ColKey {
    Original(usize),
    New(u64),
}

type CellKey = (RowKey, ColKey);
type CellEdit = (CellKey, Option<String>);

/// One undo-able action. Cell edits and structural edits (insert/delete
/// row/col) share ONE stack so Cmd+Z always reverts whatever happened
/// last, regardless of kind.
enum Action {
    /// One or more cell writes (a single `set` is a 1-entry group; a paste
    /// via `set_many` is one group covering the whole batch) — same
    /// "revert as one step" contract the plain cell-edit overlay always had.
    SetCells(Vec<CellEdit>),
    InsertRow { at: usize, key: RowKey },
    DeleteRow { at: usize, key: RowKey },
    InsertCol { at: usize, key: ColKey },
    DeleteCol { at: usize, key: ColKey },
}

/// The full mutable state layered on top of an immutable `CsvIndex`: which
/// logical row/column currently maps to which original-or-new source
/// (`row_order`/`col_order`), the cell-value edits on top of that
/// (`cell_edits`, keyed by the STABLE `RowKey`/`ColKey` pair, never by a
/// logical position), and one shared undo/redo stack covering both kinds
/// of change.
///
/// Every read path (get_rows, search, sort/filter, save) must go through
/// `read_logical_row`/`row_count`/`col_count` here — never `index`
/// directly — since the logical row/column count and the mapping to
/// original data can differ from the file's own shape the moment a
/// row/column has been inserted or deleted.
pub struct Overlay {
    row_order: Vec<RowKey>,
    col_order: Vec<ColKey>,
    next_row_id: u64,
    next_col_id: u64,
    cell_edits: HashMap<CellKey, String>,
    undo_stack: Vec<Action>,
    redo_stack: Vec<Action>,
}

impl Overlay {
    /// `row_count`/`col_count` are the file's shape AT OPEN TIME (col_count
    /// is read from row 0's field count — see commands.rs::open_file; a
    /// ragged file with no rows at all opens with 0 columns and inserting a
    /// column still works, it just starts with nothing to insert relative
    /// to).
    pub fn new(row_count: usize, col_count: usize) -> Self {
        Overlay {
            row_order: (0..row_count).map(RowKey::Original).collect(),
            col_order: (0..col_count).map(ColKey::Original).collect(),
            next_row_id: 0,
            next_col_id: 0,
            cell_edits: HashMap::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn row_count(&self) -> usize {
        self.row_order.len()
    }

    pub fn col_count(&self) -> usize {
        self.col_order.len()
    }

    fn cell_key(&self, row: usize, col: usize) -> Option<CellKey> {
        Some((*self.row_order.get(row)?, *self.col_order.get(col)?))
    }

    /// The overlay-only value at a LOGICAL (row, col) — `None` means "not
    /// edited, use the raw/fallback value" (out-of-range also returns
    /// `None`, same as a cache miss). Callers merge this with the raw value
    /// themselves via `read_logical_row` below (or, for a single cell,
    /// by calling this after resolving the raw value some other way).
    pub fn get(&self, row: usize, col: usize) -> Option<&String> {
        let key = self.cell_key(row, col)?;
        self.cell_edits.get(&key)
    }

    /// Reads one full LOGICAL row, overlay-merged, resolving raw fallback
    /// values through `index`/`file` for cells whose row AND column are
    /// both `Original` — any cell touching an inserted row or an inserted
    /// column has no original data at all, so it starts as an empty string
    /// until edited (matching how a freshly-inserted row/column reads in
    /// every spreadsheet-like editor).
    pub fn read_logical_row(
        &self,
        index: &CsvIndex,
        file: &mut File,
        row: usize,
    ) -> io::Result<Vec<String>> {
        let row_key = *self
            .row_order
            .get(row)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "row out of range"))?;
        let raw_row: Vec<String> = match row_key {
            RowKey::Original(orig_r) => index.read_row(file, orig_r)?,
            RowKey::New(_) => Vec::new(),
        };
        let mut result = Vec::with_capacity(self.col_order.len());
        for &col_key in &self.col_order {
            let raw_cell = match (row_key, col_key) {
                (RowKey::Original(_), ColKey::Original(orig_c)) => {
                    raw_row.get(orig_c).cloned().unwrap_or_default()
                }
                _ => String::new(),
            };
            let value = self
                .cell_edits
                .get(&(row_key, col_key))
                .cloned()
                .unwrap_or(raw_cell);
            result.push(value);
        }
        Ok(result)
    }

    pub fn set(&mut self, row: usize, col: usize, value: String) {
        let Some(key) = self.cell_key(row, col) else { return };
        let old = self.cell_edits.insert(key, value);
        self.undo_stack.push(Action::SetCells(vec![(key, old)]));
        self.redo_stack.clear();
    }

    /// Batched write (paste): all `edits` land in ONE undo-stack group.
    /// `edits` are (row, col, value) in LOGICAL coordinates, same shape the
    /// old cell-only overlay took.
    pub fn set_many(&mut self, edits: Vec<(usize, usize, String)>) {
        let mut group = Vec::with_capacity(edits.len());
        for (row, col, value) in edits {
            let Some(key) = self.cell_key(row, col) else { continue };
            let old = self.cell_edits.insert(key, value);
            group.push((key, old));
        }
        if group.is_empty() {
            return;
        }
        self.undo_stack.push(Action::SetCells(group));
        self.redo_stack.clear();
    }

    /// Inserts a brand-new, entirely blank row at logical position `at`
    /// (0..=row_count() — inserting AT row_count() appends at the end,
    /// same as "insert below the last row"). Its cells read as empty
    /// strings until edited; never touches the original file.
    pub fn insert_row(&mut self, at: usize) {
        let at = at.min(self.row_order.len());
        let key = RowKey::New(self.next_row_id);
        self.next_row_id += 1;
        self.row_order.insert(at, key);
        self.undo_stack.push(Action::InsertRow { at, key });
        self.redo_stack.clear();
    }

    /// Removes the row at logical position `at` from the display order.
    /// Its cell edits (if any) are NOT deleted from `cell_edits` — they
    /// simply become unreachable (nothing in `row_order` points at that
    /// `RowKey` anymore) until an undo re-inserts the same key, at which
    /// point they reappear intact. Returns `Err` if `at` is out of range.
    pub fn delete_row(&mut self, at: usize) -> Result<(), String> {
        if at >= self.row_order.len() {
            return Err(format!("row {at} out of range (0..{})", self.row_order.len()));
        }
        let key = self.row_order.remove(at);
        self.undo_stack.push(Action::DeleteRow { at, key });
        self.redo_stack.clear();
        Ok(())
    }

    /// Same as `insert_row`, for columns.
    pub fn insert_col(&mut self, at: usize) {
        let at = at.min(self.col_order.len());
        let key = ColKey::New(self.next_col_id);
        self.next_col_id += 1;
        self.col_order.insert(at, key);
        self.undo_stack.push(Action::InsertCol { at, key });
        self.redo_stack.clear();
    }

    /// Same as `delete_row`, for columns.
    pub fn delete_col(&mut self, at: usize) -> Result<(), String> {
        if at >= self.col_order.len() {
            return Err(format!("col {at} out of range (0..{})", self.col_order.len()));
        }
        let key = self.col_order.remove(at);
        self.undo_stack.push(Action::DeleteCol { at, key });
        self.redo_stack.clear();
        Ok(())
    }

    /// Reverts the last action (of ANY kind) as one step. Returns `false`
    /// if there is nothing to undo.
    pub fn undo(&mut self) -> bool {
        let Some(action) = self.undo_stack.pop() else {
            return false;
        };
        match action {
            Action::SetCells(group) => {
                let mut redo_group = Vec::with_capacity(group.len());
                for (key, old) in group {
                    let restored = match old {
                        Some(v) => self.cell_edits.insert(key, v),
                        None => self.cell_edits.remove(&key),
                    };
                    redo_group.push((key, restored));
                }
                self.redo_stack.push(Action::SetCells(redo_group));
            }
            Action::InsertRow { at, key } => {
                self.row_order.remove(at);
                self.redo_stack.push(Action::InsertRow { at, key });
            }
            Action::DeleteRow { at, key } => {
                self.row_order.insert(at, key);
                self.redo_stack.push(Action::DeleteRow { at, key });
            }
            Action::InsertCol { at, key } => {
                self.col_order.remove(at);
                self.redo_stack.push(Action::InsertCol { at, key });
            }
            Action::DeleteCol { at, key } => {
                self.col_order.insert(at, key);
                self.redo_stack.push(Action::DeleteCol { at, key });
            }
        }
        true
    }

    /// Re-applies the last undone action. Returns `false` if there is
    /// nothing to redo (also cleared whenever a new action is taken after
    /// an undo).
    pub fn redo(&mut self) -> bool {
        let Some(action) = self.redo_stack.pop() else {
            return false;
        };
        match action {
            Action::SetCells(group) => {
                let mut undo_group = Vec::with_capacity(group.len());
                for (key, val) in group {
                    let restored = match val {
                        Some(v) => self.cell_edits.insert(key, v),
                        None => self.cell_edits.remove(&key),
                    };
                    undo_group.push((key, restored));
                }
                self.undo_stack.push(Action::SetCells(undo_group));
            }
            Action::InsertRow { at, key } => {
                self.row_order.insert(at, key);
                self.undo_stack.push(Action::InsertRow { at, key });
            }
            Action::DeleteRow { at, key } => {
                self.row_order.remove(at);
                self.undo_stack.push(Action::DeleteRow { at, key });
            }
            Action::InsertCol { at, key } => {
                self.col_order.insert(at, key);
                self.undo_stack.push(Action::InsertCol { at, key });
            }
            Action::DeleteCol { at, key } => {
                self.col_order.remove(at);
                self.undo_stack.push(Action::DeleteCol { at, key });
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("gigagrid_overlay_test_{}_{}.csv", name, std::process::id()));
        let mut f = File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn set_then_get_returns_new_value() {
        let mut overlay = Overlay::new(5, 3);
        overlay.set(3, 1, "edited".to_string());
        assert_eq!(overlay.get(3, 1), Some(&"edited".to_string()));
    }

    #[test]
    fn get_unset_cell_returns_none() {
        let overlay = Overlay::new(5, 3);
        assert_eq!(overlay.get(0, 0), None);
    }

    #[test]
    fn set_overwrites_previous_value() {
        let mut overlay = Overlay::new(5, 3);
        overlay.set(0, 0, "first".to_string());
        overlay.set(0, 0, "second".to_string());
        assert_eq!(overlay.get(0, 0), Some(&"second".to_string()));
    }

    #[test]
    fn undo_reverts_single_edit() {
        let mut overlay = Overlay::new(5, 3);
        overlay.set(0, 0, "new".to_string());
        assert!(overlay.undo());
        assert_eq!(overlay.get(0, 0), None);
    }

    #[test]
    fn redo_reapplies_undone_edit() {
        let mut overlay = Overlay::new(5, 3);
        overlay.set(0, 0, "new".to_string());
        overlay.undo();
        assert!(overlay.redo());
        assert_eq!(overlay.get(0, 0), Some(&"new".to_string()));
    }

    #[test]
    fn undo_on_empty_stack_returns_false() {
        let mut overlay = Overlay::new(5, 3);
        assert!(!overlay.undo());
    }

    #[test]
    fn set_many_undo_reverts_whole_batch_in_one_step() {
        let mut overlay = Overlay::new(5, 3);
        overlay.set_many(vec![
            (0, 0, "a".to_string()),
            (0, 1, "b".to_string()),
            (1, 0, "c".to_string()),
        ]);
        assert_eq!(overlay.get(0, 0), Some(&"a".to_string()));
        assert_eq!(overlay.get(0, 1), Some(&"b".to_string()));
        assert_eq!(overlay.get(1, 0), Some(&"c".to_string()));

        assert!(overlay.undo());

        assert_eq!(overlay.get(0, 0), None);
        assert_eq!(overlay.get(0, 1), None);
        assert_eq!(overlay.get(1, 0), None);
    }

    #[test]
    fn undo_then_new_edit_clears_redo_stack() {
        let mut overlay = Overlay::new(5, 3);
        overlay.set(0, 0, "first".to_string());
        overlay.undo();
        overlay.set(0, 0, "second".to_string());
        assert!(!overlay.redo()); // redo history invalidated by the new edit
        assert_eq!(overlay.get(0, 0), Some(&"second".to_string()));
    }

    #[test]
    fn insert_row_reads_as_blank_until_edited() {
        let path = write_temp("insert_row_blank", "a,b\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(2, 2);
        overlay.insert_row(1); // between row 0 ("a,b") and row 1 ("c,d")
        assert_eq!(overlay.row_count(), 3);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 0).unwrap(), vec!["a", "b"]);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 1).unwrap(), vec!["", ""]);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 2).unwrap(), vec!["c", "d"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn insert_row_edits_land_on_the_new_row_not_the_one_after_it() {
        let path = write_temp("insert_row_edit", "a,b\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(2, 2);
        overlay.insert_row(1);
        overlay.set(1, 0, "NEW".to_string());
        assert_eq!(
            overlay.read_logical_row(&index, &mut file, 1).unwrap(),
            vec!["NEW", ""]
        );
        // the ORIGINAL row 1 ("c,d") — now at logical position 2 — must be
        // untouched: the edit must not have landed there by position.
        assert_eq!(overlay.read_logical_row(&index, &mut file, 2).unwrap(), vec!["c", "d"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn delete_row_removes_it_and_shifts_the_rest_up() {
        let path = write_temp("delete_row", "a,b\nc,d\ne,f\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(3, 2);
        overlay.delete_row(1).unwrap(); // remove "c,d"
        assert_eq!(overlay.row_count(), 2);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 0).unwrap(), vec!["a", "b"]);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 1).unwrap(), vec!["e", "f"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn delete_row_out_of_range_errors() {
        let mut overlay = Overlay::new(2, 2);
        assert!(overlay.delete_row(5).is_err());
    }

    #[test]
    fn undo_delete_row_restores_it_at_the_same_position_with_edits_intact() {
        let path = write_temp("undo_delete_row", "a,b\nc,d\ne,f\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(3, 2);
        overlay.set(1, 0, "EDITED".to_string()); // edit row 1 ("c,d") before deleting it
        overlay.delete_row(1).unwrap();
        assert_eq!(overlay.row_count(), 2);

        assert!(overlay.undo()); // undoes the delete, NOT the earlier edit
        assert_eq!(overlay.row_count(), 3);
        assert_eq!(
            overlay.read_logical_row(&index, &mut file, 1).unwrap(),
            vec!["EDITED", "d"],
            "the row's own edit must still be attached to it after being restored"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn redo_delete_row_removes_it_again() {
        let path = write_temp("redo_delete_row", "a,b\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(2, 2);
        overlay.delete_row(0).unwrap();
        overlay.undo();
        assert_eq!(overlay.row_count(), 2);
        assert!(overlay.redo());
        assert_eq!(overlay.row_count(), 1);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 0).unwrap(), vec!["c", "d"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn undo_insert_row_removes_exactly_the_inserted_one() {
        let path = write_temp("undo_insert_row", "a,b\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(2, 2);
        overlay.insert_row(1);
        assert_eq!(overlay.row_count(), 3);
        assert!(overlay.undo());
        assert_eq!(overlay.row_count(), 2);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 0).unwrap(), vec!["a", "b"]);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 1).unwrap(), vec!["c", "d"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn insert_col_reads_as_blank_for_every_row_until_edited() {
        let path = write_temp("insert_col", "a,b\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(2, 2);
        overlay.insert_col(1); // between col 0 and col 1
        assert_eq!(overlay.col_count(), 3);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 0).unwrap(), vec!["a", "", "b"]);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 1).unwrap(), vec!["c", "", "d"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn delete_col_removes_it_from_every_row() {
        let path = write_temp("delete_col", "a,b,c\nd,e,f\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(2, 3);
        overlay.delete_col(1).unwrap(); // remove the middle column
        assert_eq!(overlay.col_count(), 2);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 0).unwrap(), vec!["a", "c"]);
        assert_eq!(overlay.read_logical_row(&index, &mut file, 1).unwrap(), vec!["d", "f"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn delete_col_out_of_range_errors() {
        let mut overlay = Overlay::new(2, 2);
        assert!(overlay.delete_col(9).is_err());
    }

    #[test]
    fn undo_delete_col_restores_it_with_edits_intact() {
        let path = write_temp("undo_delete_col", "a,b,c\nd,e,f\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(2, 3);
        overlay.set(0, 1, "EDITED".to_string());
        overlay.delete_col(1).unwrap();
        assert!(overlay.undo());
        assert_eq!(overlay.col_count(), 3);
        assert_eq!(
            overlay.read_logical_row(&index, &mut file, 0).unwrap(),
            vec!["a", "EDITED", "c"]
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mixed_undo_stack_reverts_structural_and_cell_edits_in_true_chronological_order() {
        let path = write_temp("mixed_undo", "a,b\nc,d\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(2, 2);
        overlay.set(0, 0, "EDIT1".to_string()); // 1: cell edit
        overlay.insert_row(1); // 2: insert row
        overlay.set(1, 0, "EDIT2".to_string()); // 3: cell edit on the new row

        assert!(overlay.undo()); // undoes 3
        assert_eq!(overlay.read_logical_row(&index, &mut file, 1).unwrap(), vec!["", ""]);
        assert_eq!(overlay.row_count(), 3);

        assert!(overlay.undo()); // undoes 2
        assert_eq!(overlay.row_count(), 2);

        assert!(overlay.undo()); // undoes 1
        assert_eq!(
            overlay.read_logical_row(&index, &mut file, 0).unwrap(),
            vec!["a", "b"]
        );

        assert!(!overlay.undo()); // nothing left
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn new_row_and_new_col_intersection_reads_blank() {
        let path = write_temp("new_row_col", "a,b\n");
        let index = CsvIndex::build(&path).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut overlay = Overlay::new(1, 2);
        overlay.insert_row(1);
        overlay.insert_col(2);
        overlay.set(1, 2, "X".to_string());
        assert_eq!(
            overlay.read_logical_row(&index, &mut file, 1).unwrap(),
            vec!["", "", "X"]
        );
        std::fs::remove_file(&path).ok();
    }
}
