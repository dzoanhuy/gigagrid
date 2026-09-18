import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconChevronRight,
  IconChevronDown,
  IconArrowUp,
  IconArrowDown,
  IconClose,
} from "../icons";
import { formatMatchCount } from "../tabNav";

const SEARCH_DEBOUNCE_MS = 200;

export interface SearchPanelHandle {
  focusAndSelect: () => void;
  findNext: () => void;
  findPrev: () => void;
}

interface SearchPanelProps {
  tabId: number;
  visible: boolean;
  onClose: () => void;
  onNavigate: (row: number, col?: number) => void;
  onReplaced: () => void;
  viewActive: boolean;
}

export const SearchPanel = forwardRef<SearchPanelHandle, SearchPanelProps>(function SearchPanel(
  { tabId, visible, onClose, onNavigate, onReplaced, viewActive },
  ref,
) {
  const [query, setQuery] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [cursor, setCursor] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [totalMatches, setTotalMatches] = useState<number | null>(null);
  const [matchOrdinal, setMatchOrdinal] = useState(0);

  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const totalMatchesRef = useRef<number | null>(null);
  const cursorRef = useRef<{ row: number; col: number }>({ row: 0, col: 0 });
  const queryRef = useRef(query);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    totalMatchesRef.current = totalMatches;
  }, [totalMatches]);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useImperativeHandle(ref, () => ({
    focusAndSelect: () => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    },
    findNext: () => {
      runSearch(queryRef.current, cursorRef.current, "next");
    },
    findPrev: () => {
      runSearch(queryRef.current, cursorRef.current, "prev");
    },
  }));

  // Focus and select all on show
  useEffect(() => {
    if (visible) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [visible]);

  function runSearch(
    q: string,
    from: { row: number; col: number },
    direction: "next" | "prev",
    isInitial = false,
    knownTotal?: number,
  ) {
    if (!q || viewActive) return;
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
        cursorRef.current = { row, col };
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
        console.error("search failed:", err);
      });
  }

  async function replaceCurrent() {
    if (!query || viewActive) return;
    try {
      const changed = await invoke<boolean>("replace_cell", {
        row: cursorRef.current.row,
        col: cursorRef.current.col,
        query,
        replacement,
        tabId,
      });
      if (!changed) return;
      onReplaced();
      const freshTotal = await invoke<number>("count_matches", { tabId, query });
      setTotalMatches(freshTotal);
      totalMatchesRef.current = freshTotal;
      runSearch(query, cursorRef.current, "next", false, freshTotal);
    } catch (err) {
      console.error("replace failed:", err);
    }
  }

  function replaceAll() {
    if (!query || viewActive) return;
    invoke<number>("replace_all", { query, replacement, tabId })
      .then((count) => {
        if (count === 0) return;
        onReplaced();
        setTotalMatches(0);
        totalMatchesRef.current = 0;
        setMatchOrdinal(0);
      })
      .catch((err) => console.error("replace all failed:", err));
  }

  // When query or tabId changes, count matches and jump to first match
  useEffect(() => {
    if (!query) {
      setTotalMatches(null);
      setMatchOrdinal(0);
      return;
    }
    if (viewActive) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);

    debounceRef.current = window.setTimeout(() => {
      invoke<number>("count_matches", { tabId, query })
        .then((count) => {
          setTotalMatches(count);
          totalMatchesRef.current = count;
          if (count > 0) {
            runSearch(query, { row: 0, col: 0 }, "next", true, count);
          } else {
            setMatchOrdinal(0);
          }
        })
        .catch((err) => console.error("count_matches failed:", err));
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tabId, viewActive]);

  if (!visible) return null;

  return (
    <div
      className="floating-search-panel"
      style={{
        position: "absolute",
        top: 8,
        right: 16,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 6,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
      }}
    >
      {/* Row 1: Search */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          className="icon-btn"
          style={{ width: 22, height: 22 }}
          title="Toggle replace"
          aria-label={showReplace ? "Hide Replace" : "Show Replace"}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? <IconChevronDown /> : <IconChevronRight />}
        </button>

        <input
          ref={inputRef}
          placeholder="Search…"
          value={query}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
              runSearch(query, cursor, e.shiftKey ? "prev" : "next");
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          disabled={viewActive}
          style={{ width: 150 }}
        />

        <span
          style={{
            fontSize: 11,
            opacity: 0.75,
            minWidth: 44,
            textAlign: "center",
            userSelect: "none",
          }}
        >
          {formatMatchCount(matchOrdinal, totalMatches)}
        </span>

        <button
          className="icon-btn"
          style={{ width: 22, height: 22 }}
          title="Previous match (Shift+Enter)"
          onClick={() => runSearch(query, cursor, "prev")}
          disabled={!query || totalMatches === 0 || viewActive}
        >
          <IconArrowUp />
        </button>

        <button
          className="icon-btn"
          style={{ width: 22, height: 22 }}
          title="Next match (Enter)"
          onClick={() => runSearch(query, cursor, "next")}
          disabled={!query || totalMatches === 0 || viewActive}
        >
          <IconArrowDown />
        </button>

        <button
          className="icon-btn"
          style={{ width: 22, height: 22 }}
          title="Close (Escape)"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      {/* Row 2: Replace (Collapsible) */}
      {showReplace && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {/* Spacer to align with search input */}
          <div style={{ width: 22, flexShrink: 0 }} />

          <input
            placeholder="Replace…"
            value={replacement}
            onChange={(e) => setReplacement(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                replaceCurrent();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            disabled={viewActive}
            style={{ width: 150 }}
          />

          <button
            onClick={replaceCurrent}
            disabled={!query || totalMatches === 0 || viewActive}
            style={{ fontSize: 12, padding: "2px 6px" }}
          >
            Replace
          </button>
          <button
            onClick={replaceAll}
            disabled={!query || totalMatches === 0 || viewActive}
            style={{ fontSize: 12, padding: "2px 6px" }}
          >
            Replace All
          </button>
        </div>
      )}
    </div>
  );
});
