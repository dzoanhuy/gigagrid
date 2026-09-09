import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cell } from "./Cell";
import type { GridStats } from "./StatusBar";

const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_DEBOUNCE_MS = 50;
const MAX_CACHE_ROWS = 20000;
const GUTTER_WIDTH = 48;
const HEADER_HEIGHT = ROW_HEIGHT;
// Columns aren't fixed-width in this phase (cells auto-size to content), so
// goto-column scroll is an estimate, not exact — good enough for "get roughly
// there", refine later if a fixed column-width model is added.
const ESTIMATED_COL_WIDTH = 120;

export interface VisibleRange {
  start: number;
  count: number;
}

/**
 * Pure: given scroll position + viewport size, compute the row range to
 * fetch — visible rows plus an overscan buffer on each side, clipped to
 * [0, totalRows). No IPC, no state — unit-testable in isolation.
 */
export function computeWindow(
  scrollTop: number,
  rowHeight: number,
  viewportHeight: number,
  totalRows: number,
  overscan: number,
): VisibleRange {
  if (totalRows <= 0 || viewportHeight <= 0 || rowHeight <= 0) {
    return { start: 0, count: 0 };
  }
  const rawStart = Math.floor(scrollTop / rowHeight) - overscan;
  const rawEnd = Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan;
  const start = Math.max(0, rawStart);
  const end = Math.min(totalRows, rawEnd);
  return { start, count: Math.max(0, end - start) };
}

interface GridProps {
  rowCount: number;
  showGridChrome: boolean;
  freezeHeader: boolean;
  onStatsChange?: (stats: GridStats) => void;
}

export interface GridHandle {
  scrollToRow: (row: number) => void;
  scrollToCol: (col: number) => void;
}

interface CellPos {
  row: number;
  col: number;
}

export const Grid = forwardRef<GridHandle, GridProps>(function Grid({ rowCount, showGridChrome, freezeHeader, onStatsChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fetchTimer = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowsByIndex, setRowsByIndex] = useState<Map<number, string[]>>(new Map());
  const [selStart, setSelStart] = useState<CellPos | null>(null);
  const [selEnd, setSelEnd] = useState<CellPos | null>(null);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const selectingRef = useRef(false);

  useEffect(() => {
    const onMouseUp = () => {
      selectingRef.current = false;
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToRow: (row: number) => {
      const el = containerRef.current;
      if (!el) return;
      el.scrollTop = row * ROW_HEIGHT;
    },
    scrollToCol: (col: number) => {
      const el = containerRef.current;
      if (!el) return;
      el.scrollLeft = col * ESTIMATED_COL_WIDTH;
    },
  }));

  const range = computeWindow(scrollTop, ROW_HEIGHT, viewportHeight, rowCount, OVERSCAN);

  useEffect(() => {
    if (range.count === 0) return;
    let missing = false;
    for (let r = range.start; r < range.start + range.count; r++) {
      if (!rowsByIndex.has(r)) {
        missing = true;
        break;
      }
    }
    if (!missing) return;

    if (fetchTimer.current !== null) window.clearTimeout(fetchTimer.current);
    fetchTimer.current = window.setTimeout(() => {
      invoke<string[][]>("get_rows", { start: range.start, count: range.count }).then(
        (rows) => {
          setRowsByIndex((prev) => {
            const next = prev.size > MAX_CACHE_ROWS ? new Map<number, string[]>() : new Map(prev);
            rows.forEach((row, i) => next.set(range.start + i, row));
            return next;
          });
        },
      );
    }, FETCH_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.count]);

  useEffect(() => {
    if (!freezeHeader || rowCount === 0) return;
    if (rowsByIndex.has(0)) return;
    invoke<string[][]>("get_rows", { start: 0, count: 1 }).then((rows) => {
      if (!rows[0]) return;
      setRowsByIndex((prev) => new Map(prev).set(0, rows[0]));
    });
  }, [freezeHeader, rowCount]);

  function commitCell(rowIndex: number, colIndex: number, value: string) {
    invoke("set_cell", { row: rowIndex, col: colIndex, value }).then(() => {
      // Optimistic local update — get_rows already merges the overlay, but
      // we don't want the cell to flash back to the stale raw value while
      // waiting for a future refetch (this phase's Risk: overlay must be
      // visible everywhere a cell is read, including right after editing).
      setRowsByIndex((prev) => {
        const row = prev.get(rowIndex);
        if (!row) return prev;
        const next = new Map(prev);
        const updated = [...row];
        updated[colIndex] = value;
        next.set(rowIndex, updated);
        return next;
      });
    });
  }

  function handleOverflow(rowIndex: number) {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = rowIndex * ROW_HEIGHT;
  }

  function selectionBounds() {
    if (!selStart || !selEnd) return null;
    return {
      rowMin: Math.min(selStart.row, selEnd.row),
      rowMax: Math.max(selStart.row, selEnd.row),
      colMin: Math.min(selStart.col, selEnd.col),
      colMax: Math.max(selStart.col, selEnd.col),
    };
  }

  useEffect(() => {
    const b = selectionBounds();
    const colCount = rowsByIndex.get(0)?.length ?? 0;
    onStatsChange?.({
      totalCols: colCount,
      cursor: selEnd,
      selection: b ? { rows: b.rowMax - b.rowMin + 1, cols: b.colMax - b.colMin + 1 } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selStart, selEnd, rowsByIndex, onStatsChange]);

  function isSelected(row: number, col: number) {
    const b = selectionBounds();
    if (!b) return false;
    return row >= b.rowMin && row <= b.rowMax && col >= b.colMin && col <= b.colMax;
  }

  function startSelect(row: number, col: number) {
    selectingRef.current = true;
    setSelStart({ row, col });
    setSelEnd({ row, col });
    containerRef.current?.focus();
  }

  function extendSelect(row: number, col: number) {
    if (selectingRef.current) setSelEnd({ row, col });
  }

  // Applying an undo/redo can touch cells anywhere in the file (including
  // rows outside the currently cached window) — the simplest CORRECT thing
  // is to drop the local cache entirely and let the existing "missing rows"
  // fetch effect reload the visible window with fresh overlay-merged data,
  // rather than trying to patch the cache with exactly what changed.
  function invalidateCache() {
    setRowsByIndex(new Map());
  }

  async function copySelection() {
    const b = selectionBounds();
    if (!b) return;
    const lines: string[] = [];
    for (let r = b.rowMin; r <= b.rowMax; r++) {
      const row = rowsByIndex.get(r);
      const cells: string[] = [];
      for (let c = b.colMin; c <= b.colMax; c++) {
        cells.push(row?.[c] ?? "");
      }
      lines.push(cells.join("\t"));
    }
    await navigator.clipboard.writeText(lines.join("\n"));
  }

  async function pasteSelection() {
    const b = selectionBounds();
    if (!b) return;
    const text = await navigator.clipboard.readText();
    const grid = text.replace(/\r/g, "").split("\n").map((line) => line.split("\t"));
    const edits: [number, number, string][] = [];
    grid.forEach((line, ri) => {
      line.forEach((value, ci) => {
        edits.push([b.rowMin + ri, b.colMin + ci, value]);
      });
    });
    if (edits.length === 0) return;
    await invoke("set_cells_batch", { edits });
    setRowsByIndex((prev) => {
      const next = new Map(prev);
      for (const [r, c, v] of edits) {
        const row = next.get(r);
        if (row) {
          const updated = [...row];
          updated[c] = v;
          next.set(r, updated);
        }
      }
      return next;
    });
  }

  async function handleKeyDown(e: React.KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === "c") {
      e.preventDefault();
      await copySelection();
    } else if (e.key === "v") {
      e.preventDefault();
      await pasteSelection();
    } else if (e.key === "z" && e.shiftKey) {
      e.preventDefault();
      await invoke("redo");
      invalidateCache();
    } else if (e.key === "z") {
      e.preventDefault();
      await invoke("undo");
      invalidateCache();
    }
  }

  const totalHeight = rowCount * ROW_HEIGHT;
  const colCount = rowsByIndex.get(0)?.length ?? 0;
  const chromeOffset = showGridChrome ? HEADER_HEIGHT : 0;
  const freezeOffset = freezeHeader ? HEADER_HEIGHT : 0;
  const topOffset = chromeOffset + freezeOffset;
  const chromeBorder = showGridChrome
    ? { borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }
    : {};
  const frozenRow = freezeHeader ? rowsByIndex.get(0) : undefined;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={handleKeyDown}
      style={{ overflow: "auto", height: "100%", position: "relative", outline: "none" }}
    >
      {showGridChrome && (
        <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 3, background: "var(--bg)" }}>
          <div
            style={{
              position: "sticky",
              left: 0,
              zIndex: 4,
              minWidth: GUTTER_WIDTH,
              height: HEADER_HEIGHT,
              background: "var(--bg)",
              ...chromeBorder,
            }}
          />
          {Array.from({ length: colCount }, (_, c) => (
            <div
              key={c}
              style={{
                minWidth: 100,
                height: HEADER_HEIGHT,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                ...chromeBorder,
              }}
            >
              {c + 1}
            </div>
          ))}
        </div>
      )}
      {freezeHeader && frozenRow && (
        <div
          style={{
            position: "sticky",
            top: chromeOffset,
            zIndex: 3,
            display: "flex",
            height: HEADER_HEIGHT,
            background: "var(--bg)",
          }}
        >
          {showGridChrome && (
            <div
              style={{
                position: "sticky",
                left: 0,
                zIndex: 4,
                minWidth: GUTTER_WIDTH,
                background: "var(--bg)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                ...chromeBorder,
              }}
            >
              1
            </div>
          )}
          {frozenRow.map((cell, ci) => (
            <div key={ci} style={{ position: "relative", minWidth: 100, ...chromeBorder }}>
              <Cell
                value={cell}
                onCommit={(v) => commitCell(0, ci, v)}
                onOverflow={() => handleOverflow(0)}
                onEditingChange={(editing) => setEditingRow(editing ? 0 : null)}
              />
            </div>
          ))}
        </div>
      )}
      <div style={{ height: totalHeight, position: "relative", marginTop: topOffset }}>
        {Array.from({ length: range.count }, (_, i) => {
          const rowIndex = range.start + i;
          if (freezeHeader && rowIndex === 0) return null;
          const row = rowsByIndex.get(rowIndex);
          return (
            <div
              key={rowIndex}
              style={{
                position: "absolute",
                top: rowIndex * ROW_HEIGHT,
                height: ROW_HEIGHT,
                display: "flex",
                width: "100%",
                zIndex: editingRow === rowIndex ? 5 : undefined,
              }}
            >
              {showGridChrome && (
                <div
                  style={{
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    minWidth: GUTTER_WIDTH,
                    background: "var(--bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    ...chromeBorder,
                  }}
                >
                  {rowIndex + 1}
                </div>
              )}
              {row
                ? row.map((cell, ci) => (
                    <div
                      key={ci}
                      onMouseDown={() => startSelect(rowIndex, ci)}
                      onMouseEnter={() => extendSelect(rowIndex, ci)}
                      style={{
                        position: "relative",
                        minWidth: 100,
                        background: isSelected(rowIndex, ci) ? "rgba(70,130,255,0.25)" : undefined,
                        ...chromeBorder,
                      }}
                    >
                      <Cell
                        value={cell}
                        onCommit={(v) => commitCell(rowIndex, ci, v)}
                        onOverflow={() => handleOverflow(rowIndex)}
                        onEditingChange={(editing) => setEditingRow(editing ? rowIndex : null)}
                      />
                    </div>
                  ))
                : <div style={{ padding: "0 6px", opacity: 0.4 }}>…</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
});
