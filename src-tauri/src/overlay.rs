use std::collections::HashMap;

/// In-memory diff of cell edits, keyed by ORIGINAL (row, col) coordinates —
/// never mutated against the raw file until save (phase 07). Every read
/// path (get_rows here, search/sort-filter/save in later phases) must
/// check here FIRST before falling back to the raw file value, or an
/// edited cell would appear to "revert" the moment it scrolls out of and
/// back into view.
pub struct Overlay {
    edits: HashMap<(usize, usize), String>,
}

impl Overlay {
    pub fn new() -> Self {
        Overlay {
            edits: HashMap::new(),
        }
    }

    pub fn set(&mut self, row: usize, col: usize, value: String) {
        self.edits.insert((row, col), value);
    }

    pub fn get(&self, row: usize, col: usize) -> Option<&String> {
        self.edits.get(&(row, col))
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
}
