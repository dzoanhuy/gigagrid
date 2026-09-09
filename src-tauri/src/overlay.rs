use std::collections::HashMap;

type UndoEntry = (usize, usize, Option<String>);

/// In-memory diff of cell edits, keyed by ORIGINAL (row, col) coordinates —
/// never mutated against the raw file until save (phase 07). Every read
/// path (get_rows here, search/sort-filter/save in later phases) must
/// check here FIRST before falling back to the raw file value, or an
/// edited cell would appear to "revert" the moment it scrolls out of and
/// back into view.
///
/// `undo_stack`/`redo_stack` hold GROUPS of entries (`Vec<UndoEntry>`)
/// rather than a flat list — a single `set` pushes a 1-entry group, a
/// `set_many` (paste) pushes one group covering the whole batch, so one
/// undo always reverts exactly one user action regardless of how many
/// cells it touched.
pub struct Overlay {
    edits: HashMap<(usize, usize), String>,
    undo_stack: Vec<Vec<UndoEntry>>,
    redo_stack: Vec<Vec<UndoEntry>>,
}

impl Overlay {
    pub fn new() -> Self {
        Overlay {
            edits: HashMap::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn set(&mut self, row: usize, col: usize, value: String) {
        let old = self.edits.insert((row, col), value);
        self.undo_stack.push(vec![(row, col, old)]);
        self.redo_stack.clear();
    }

    /// Batched write (paste): all `edits` land in ONE undo-stack group.
    pub fn set_many(&mut self, edits: Vec<(usize, usize, String)>) {
        let mut group = Vec::with_capacity(edits.len());
        for (row, col, value) in edits {
            let old = self.edits.insert((row, col), value);
            group.push((row, col, old));
        }
        self.undo_stack.push(group);
        self.redo_stack.clear();
    }

    pub fn get(&self, row: usize, col: usize) -> Option<&String> {
        self.edits.get(&(row, col))
    }

    /// Reverts the last group as one step. Returns false if there is
    /// nothing to undo.
    pub fn undo(&mut self) -> bool {
        let Some(group) = self.undo_stack.pop() else {
            return false;
        };
        let mut redo_group = Vec::with_capacity(group.len());
        for (row, col, old) in group {
            let restored = match old {
                Some(v) => self.edits.insert((row, col), v),
                None => self.edits.remove(&(row, col)),
            };
            redo_group.push((row, col, restored));
        }
        self.redo_stack.push(redo_group);
        true
    }

    /// Re-applies the last undone group. Returns false if there is nothing
    /// to redo (also cleared whenever a new edit is made after an undo).
    pub fn redo(&mut self) -> bool {
        let Some(group) = self.redo_stack.pop() else {
            return false;
        };
        let mut undo_group = Vec::with_capacity(group.len());
        for (row, col, val) in group {
            let restored = match val {
                Some(v) => self.edits.insert((row, col), v),
                None => self.edits.remove(&(row, col)),
            };
            undo_group.push((row, col, restored));
        }
        self.undo_stack.push(undo_group);
        true
    }
}

impl Default for Overlay {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_get_returns_new_value() {
        let mut overlay = Overlay::new();
        overlay.set(3, 1, "edited".to_string());
        assert_eq!(overlay.get(3, 1), Some(&"edited".to_string()));
    }

    #[test]
    fn get_unset_cell_returns_none() {
        let overlay = Overlay::new();
        assert_eq!(overlay.get(0, 0), None);
    }

    #[test]
    fn set_overwrites_previous_value() {
        let mut overlay = Overlay::new();
        overlay.set(0, 0, "first".to_string());
        overlay.set(0, 0, "second".to_string());
        assert_eq!(overlay.get(0, 0), Some(&"second".to_string()));
    }

    #[test]
    fn undo_reverts_single_edit() {
        let mut overlay = Overlay::new();
        overlay.set(0, 0, "new".to_string());
        assert!(overlay.undo());
        assert_eq!(overlay.get(0, 0), None);
    }

    #[test]
    fn redo_reapplies_undone_edit() {
        let mut overlay = Overlay::new();
        overlay.set(0, 0, "new".to_string());
        overlay.undo();
        assert!(overlay.redo());
        assert_eq!(overlay.get(0, 0), Some(&"new".to_string()));
    }

    #[test]
    fn undo_on_empty_stack_returns_false() {
        let mut overlay = Overlay::new();
        assert!(!overlay.undo());
    }

    #[test]
    fn set_many_undo_reverts_whole_batch_in_one_step() {
        let mut overlay = Overlay::new();
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
        let mut overlay = Overlay::new();
        overlay.set(0, 0, "first".to_string());
        overlay.undo();
        overlay.set(0, 0, "second".to_string());
        assert!(!overlay.redo()); // redo history invalidated by the new edit
        assert_eq!(overlay.get(0, 0), Some(&"second".to_string()));
    }
}
