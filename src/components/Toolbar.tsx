import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const SEARCH_DEBOUNCE_MS = 200;

interface ToolbarProps {
  visible: boolean;
  onNavigate: (row: number, col?: number) => void;
}

export interface ToolbarHandle {
  focusSearch: () => void;
  findNext: () => void;
  findPrev: () => void;
}

/** Search cell-by-cell across the whole file (Cmd/Ctrl+F to show+focus this
 * box, Cmd/Ctrl+G / Enter to jump to the next match, Shift+ variants for
 * the previous one) — the matched cell is selected in the grid, and a
 * running "N / total" count is shown next to the box. Goto row/col stays a
 * separate, always-visible mini-form. */
export const Toolbar = forwardRef<ToolbarHandle, ToolbarProps>(function Toolbar(
  { visible, onNavigate },
  ref,
) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<{ row: number; col: number }>({ row: 0, col: -1 });
  const [totalMatches, setTotalMatches] = useState<number | null>(null);
  const [matchOrdinal, setMatchOrdinal] = useState(0);
  const [gotoRow, setGotoRow] = useState("");
  const [gotoCol, setGotoCol] = useState("");
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const totalMatchesRef = useRef<number | null>(null);

  useEffect(() => {
    totalMatchesRef.current = totalMatches;
  }, [totalMatches]);

  useImperativeHandle(ref, () => ({
    focusSearch: () => inputRef.current?.focus(),
    findNext: () => runSearch(query, cursor, "next"),
    findPrev: () => runSearch(query, cursor, "prev"),
  }));

  // `isInitial` = this is the FIRST lookup for a freshly-typed query (from
  // row/col 0) — sets the ordinal directly (1 if found, 0 if not) instead of
  // incrementing, so the initial fetch never double-counts as a "next" step.
  function runSearch(
    q: string,
    from: { row: number; col: number },
    direction: "next" | "prev",
    isInitial = false,
  ) {
    if (!q) return;
    invoke<[number, number] | null>("search", {
      query: q,
      fromRow: from.row,
      fromCol: from.col,
      direction,
    }).then((hit) => {
      if (!hit) {
        if (isInitial) setMatchOrdinal(0);
        return;
      }
      const [row, col] = hit;
      setCursor({ row, col });
      if (isInitial) {
        setMatchOrdinal(1);
      } else {
        setMatchOrdinal((prev) => {
          const total = totalMatchesRef.current;
          if (!total) return prev;
          const next = direction === "next" ? prev + 1 : prev - 1;
          return ((next - 1 + total) % total) + 1;
        });
      }
      onNavigate(row, col);
    });
  }

  useEffect(() => {
    if (!query) {
      setTotalMatches(null);
      setMatchOrdinal(0);
      return;
    }
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      invoke<number>("count_matches", { query }).then(setTotalMatches);
      runSearch(query, { row: 0, col: -1 }, "next", true);
    }, SEARCH_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function submitGoto(e: React.FormEvent) {
    e.preventDefault();
    const row = parseInt(gotoRow, 10);
    if (Number.isNaN(row)) return;
    const col = gotoCol ? parseInt(gotoCol, 10) : undefined;
    invoke("goto", { row }).then(() => onNavigate(row, col));
  }

  return (
    <>
      {visible && (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input
            ref={inputRef}
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
                runSearch(query, cursor, e.shiftKey ? "prev" : "next");
              }
            }}
            style={{ width: 140 }}
          />
          {query && (
            <span style={{ fontSize: 12, opacity: 0.7, minWidth: 48 }}>
              {totalMatches === null
                ? "…"
                : totalMatches === 0
                  ? "0 / 0"
                  : `${matchOrdinal} / ${totalMatches}`}
            </span>
          )}
        </div>
      )}
      <form onSubmit={submitGoto} style={{ display: "flex", gap: 4 }}>
        <input
          placeholder="Row"
          value={gotoRow}
          onChange={(e) => setGotoRow(e.currentTarget.value)}
          style={{ width: 70 }}
        />
        <input
          placeholder="Col"
          value={gotoCol}
          onChange={(e) => setGotoCol(e.currentTarget.value)}
          style={{ width: 50 }}
        />
        <button type="submit">Go</button>
      </form>
    </>
  );
});
