import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconSearch, IconHash } from "../icons";

const SEARCH_DEBOUNCE_MS = 200;

interface ToolbarProps {
  tabId: number;
  visible: boolean;
  onNavigate: (row: number, col?: number) => void;
  onToggleSearch: () => void;
  viewActive: boolean;
  onFilterChange: (active: boolean, rowCount: number) => void;
}

export function Toolbar({
  tabId,
  visible,
  onNavigate,
  onToggleSearch,
  viewActive: _viewActive,
  onFilterChange,
}: ToolbarProps) {
  const [showGoto, setShowGoto] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [gotoRow, setGotoRow] = useState("");
  const [gotoCol, setGotoCol] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => {
      invoke<number>("set_filter", { tabId, query: filterQuery }).then((rowCount) => {
        onFilterChange(filterQuery.length > 0, rowCount);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery, tabId]);

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
      <input
        placeholder="Filter…"
        value={filterQuery}
        onChange={(e) => setFilterQuery(e.currentTarget.value)}
        style={{ width: 100 }}
      />
      <button
        className="icon-btn"
        data-active={visible}
        title="Search (Cmd/Ctrl+F)"
        onClick={onToggleSearch}
      >
        <IconSearch />
      </button>
      <div style={{ position: "relative" }}>
        <button
          className="icon-btn"
          data-active={showGoto}
          title="Go to row/col"
          onClick={() => setShowGoto((v) => !v)}
        >
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
}
