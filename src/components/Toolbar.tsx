import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconSearch, IconHash, IconReplace } from "../icons";

const SEARCH_DEBOUNCE_MS = 200;

interface ToolbarProps {
  tabId: number;
  visible: boolean;
  onNavigate: (row: number, col?: number) => void;
  onToggleSearch: () => void;
  onReplaced: () => void;
}

export interface ToolbarHandle {
  focusSearch: () => void;
  findNext: () => void;
  findPrev: () => void;
}

/** Search cell-by-cell across the whole file (Cmd/Ctrl+F to show+focus this
 * box, Cmd/Ctrl+G / Enter to jump to the next match, Shift+ variants for
 * the previous one) — the matched cell is selected in the grid, and a
 * running "N / total" count is shown next to the box. Goto row/col is a
 * small popup opened from its own icon (closes itself after a successful
 * jump or Escape), matching the "Go to Line" pattern of most editors. */
export const Toolbar = forwardRef<ToolbarHandle, ToolbarProps>(function Toolbar(
  { tabId, visible, onNavigate, onToggleSearch, onReplaced },
  ref,
) {
  const [query, setQuery] = useState("");
  const [showGoto, setShowGoto] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  // col:0, not -1 — `fromCol` deserializes into a Rust `usize` on the
  // backend, which rejects a negative number outright (the whole `invoke`
  // call fails silently since nothing here used to .catch() it — count
  // still updated via the separate, unrelated `count_matches` call, so the
  // box looked like "found 1 but never jumped to it"). find_next/find_prev
  // both have a same-row fallback pass that still catches a match sitting
  // exactly at column 0, so starting from col 0 loses nothing.
  const [cursor, setCursor] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
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
    // Only replaceCurrent needs this: it already knows the FRESH total (it
    // just awaited count_matches) before calling runSearch to advance —
    // reading `totalMatchesRef.current` instead would race the ref's own
    // update (which only lands after React re-renders from the sibling
    // `setTotalMatches` call), showing a stale ordinal against the just-
    // shrunk match count.
    knownTotal?: number,
  ) {
    if (!q) return;
    invoke<[number, number] | null>("search", {
      tabId,
      query: q,
      fromRow: from.row,
      fromCol: from.col,
      direction,
    })
      .then((hit) => {
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
            const total = knownTotal ?? totalMatchesRef.current;
            if (!total) return prev;
            const next = direction === "next" ? prev + 1 : prev - 1;
            return ((next - 1 + total) % total) + 1;
          });
        }
        onNavigate(row, col);
      })
      .catch((err) => {
        // An invoke rejection here used to fail SILENTLY (count still
        // updated via the separate count_matches call, cursor/selection
        // just never moved) — surface it instead of swallowing it.
        console.error("search failed:", err);
      });
  }

  // Replaces the cell the search cursor currently sits on, then advances to
  // the NEXT match — the just-replaced cell no longer contains `query`, so
  // it can never come up again on its own, matching the usual
  // find-and-replace "Replace" behavior of stepping forward each time.
  async function replaceCurrent() {
    if (!query) return;
    try {
      const changed = await invoke<boolean>("replace_cell", {
        row: cursor.row,
        col: cursor.col,
        query,
        replacement,
        tabId,
      });
      if (!changed) return;
      onReplaced();
      const freshTotal = await invoke<number>("count_matches", { tabId, query });
      setTotalMatches(freshTotal);
      runSearch(query, cursor, "next", false, freshTotal);
    } catch (err) {
      console.error("replace failed:", err);
    }
  }

  function replaceAll() {
    if (!query) return;
    invoke<number>("replace_all", { query, replacement, tabId })
      .then((count) => {
        if (count === 0) return;
        onReplaced();
        setTotalMatches(0);
        setMatchOrdinal(0);
      })
      .catch((err) => console.error("replace all failed:", err));
  }

  useEffect(() => {
    if (!query) {
      setTotalMatches(null);
      setMatchOrdinal(0);
      return;
    }
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      invoke<number>("count_matches", { tabId, query }).then(setTotalMatches);
      runSearch(query, { row: 0, col: 0 }, "next", true);
    }, SEARCH_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function submitGoto(e: React.FormEvent) {
    e.preventDefault();
    const row = parseInt(gotoRow, 10);
    if (Number.isNaN(row)) return;
    const col = gotoCol ? parseInt(gotoCol, 10) : undefined;
    invoke("goto", { tabId, row }).then(() => {
      onNavigate(row, col);
      setShowGoto(false);
    });
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
              } else if (e.key === "Escape") {
                onToggleSearch();
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
          <button
            className="icon-btn"
            data-active={showReplace}
            title="Toggle replace"
            onClick={() => setShowReplace((v) => !v)}
          >
            <IconReplace />
          </button>
          {showReplace && (
            <>
              <input
                placeholder="Replace…"
                value={replacement}
                onChange={(e) => setReplacement(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    replaceCurrent();
                  } else if (e.key === "Escape") {
                    setShowReplace(false);
                  }
                }}
                style={{ width: 140 }}
              />
              <button onClick={replaceCurrent} disabled={!query}>
                Replace
              </button>
              <button onClick={replaceAll} disabled={!query}>
                Replace All
              </button>
            </>
          )}
        </div>
      )}
      <button className="icon-btn" data-active={visible} title="Search (Cmd/Ctrl+F)" onClick={onToggleSearch}>
        <IconSearch />
      </button>
      <div style={{ position: "relative" }}>
        <button className="icon-btn" data-active={showGoto} title="Go to row/col" onClick={() => setShowGoto((v) => !v)}>
          <IconHash />
        </button>
        {showGoto && (
          <form
            onSubmit={submitGoto}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowGoto(false);
            }}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: 0,
              zIndex: 10,
              display: "flex",
              gap: 4,
              padding: 6,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
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
        )}
      </div>
    </>
  );
});
