import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const SEARCH_DEBOUNCE_MS = 200;

interface ToolbarProps {
  onNavigate: (row: number, col?: number) => void;
}

export function Toolbar({ onNavigate }: ToolbarProps) {
  const [query, setQuery] = useState("");
  const [currentRow, setCurrentRow] = useState(0);
  const [gotoRow, setGotoRow] = useState("");
  const [gotoCol, setGotoCol] = useState("");
  const debounceRef = useRef<number | null>(null);

  function runSearch(q: string, fromRow: number) {
    invoke<number | null>("search", {
      query: q,
      fromRow,
      direction: "next",
    }).then((row) => {
      if (row !== null && row !== undefined) {
        setCurrentRow(row);
        onNavigate(row);
      }
    });
  }

  useEffect(() => {
    if (!query) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      runSearch(query, currentRow);
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
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 8 }}>
      <input
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query) {
            if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
            runSearch(query, currentRow);
          }
        }}
      />
      <form onSubmit={submitGoto} style={{ display: "flex", gap: 4 }}>
        <input
          placeholder="Row"
          value={gotoRow}
          onChange={(e) => setGotoRow(e.currentTarget.value)}
          style={{ width: 80 }}
        />
        <input
          placeholder="Col"
          value={gotoCol}
          onChange={(e) => setGotoCol(e.currentTarget.value)}
          style={{ width: 60 }}
        />
        <button type="submit">Go</button>
      </form>
    </div>
  );
}
