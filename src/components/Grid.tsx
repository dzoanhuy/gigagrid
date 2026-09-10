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
const MIN_ROW_HEIGHT = 18;
const MIN_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 100;

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
  selectCell: (row: number, col: number) => void;
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
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT);
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const selectingRef = useRef(false);

  function startColResize(e: React.MouseEvent, colIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[colIndex] ?? DEFAULT_COL_WIDTH;
    function onMove(ev: MouseEvent) {
      const next = Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX));
      setColWidths((prev) => ({ ...prev, [colIndex]: next }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startRowResize(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startHeight = rowHeight;
    function onMove(ev: MouseEvent) {
      const next = Math.max(MIN_ROW_HEIGHT, startHeight + (ev.clientY - startY));
      setRowHeight(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

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
      const offset = freezeHeader ? Math.max(0, row - 1) : row;
      el.scrollTop = offset * rowHeight;
    },
    scrollToCol: (col: number) => {
      const el = containerRef.current;
      if (!el) return;
      let left = 0;
      for (let c = 0; c < col; c++) left += colWidths[c] ?? DEFAULT_COL_WIDTH;
      el.scrollLeft = left;
    },
    selectCell: (row: number, col: number) => {
      setSelStart({ row, col });
      setSelEnd({ row, col });
      const el = containerRef.current;
      if (el) {
        const offset = freezeHeader ? Math.max(0, row - 1) : row;
        el.scrollTop = offset * rowHeight;
        let left = 0;
        for (let c = 0; c < col; c++) left += colWidths[c] ?? DEFAULT_COL_WIDTH;
        el.scrollLeft = left;
      }
    },
  }));

  // When freezeHeader is on, row 0 is permanently shown via the frozen bar and
  // is excluded from the normal scrollable list entirely (not just hidden) —
  // otherwise its vacated absolute-position slot stays empty and every row
  // below it renders one rowHeight too low, showing as a gap under the frozen
  // bar. scrollableRowCount/fetchStart below keep scrollTop, computeWindow's
  // range, and each row's rendered `top` all agreeing on the same coordinate
  // space (offset 0 = the first SCROLLABLE row, i.e. logical row 1 here).
  const scrollableRowCount = freezeHeader ? Math.max(0, rowCount - 1) : rowCount;
  const range = computeWindow(scrollTop, rowHeight, viewportHeight, scrollableRowCount, OVERSCAN);

  useEffect(() => {
    if (range.count === 0) return;
    const fetchStart = freezeHeader ? range.start + 1 : range.start;
    let missing = false;
    for (let r = fetchStart; r < fetchStart + range.count; r++) {
      if (!rowsByIndex.has(r)) {
        missing = true;
        break;
      }
    }
    if (!missing) return;

    if (fetchTimer.current !== null) window.clearTimeout(fetchTimer.current);
    fetchTimer.current = window.setTimeout(() => {
      invoke<string[][]>("get_rows", { start: fetchStart, count: range.count }).then(
        (rows) => {
          setRowsByIndex((prev) => {
            const next = prev.size > MAX_CACHE_ROWS ? new Map<number, string[]>() : new Map(prev);
            rows.forEach((row, i) => next.set(fetchStart + i, row));
            return next;
          });
        },
      );
    }, FETCH_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.count, freezeHeader]);

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
    const offset = freezeHeader ? Math.max(0, rowIndex - 1) : rowIndex;
    el.scrollTop = offset * rowHeight;
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
    // Never read from `rowsByIndex` here — it only holds whatever the
    // virtualized viewport has scrolled through, which for a selection that
    // spans far beyond the visible window (e.g. shift-click row 1 -> row
    // 10000) is nearly all of it: most rows would silently copy as empty.
    // Fetch the exact selected range fresh from the backend instead (this
    // also merges the overlay, same as every other read path).
    const count = b.rowMax - b.rowMin + 1;
    const rows = await invoke<string[][]>("get_rows", { start: b.rowMin, count });
    const lines: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
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
    } else if (e.key === "a") {
      e.preventDefault();
      setSelStart({ row: 0, col: 0 });
      setSelEnd({ row: rowCount - 1, col: Math.max(0, colCount - 1) });
    } else if (
      e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")
    ) {
      // Cmd/Ctrl+Shift+Arrow — Excel-style "extend selection to the edge":
      // keep the existing anchor (selStart), push the far corner (selEnd)
      // all the way to the top/bottom/first/last row or column.
      e.preventDefault();
      if (!selStart || !selEnd) return;
      const target = { ...selEnd };
      if (e.key === "ArrowUp") target.row = 0;
      else if (e.key === "ArrowDown") target.row = rowCount - 1;
      else if (e.key === "ArrowLeft") target.col = 0;
      else if (e.key === "ArrowRight") target.col = Math.max(0, colCount - 1);
      setSelEnd(target);
      const el = containerRef.current;
      if (el) {
        const offset = freezeHeader ? Math.max(0, target.row - 1) : target.row;
        el.scrollTop = offset * rowHeight;
      }
    }
  }

  const totalHeight = scrollableRowCount * rowHeight;
  const colCount = rowsByIndex.get(0)?.length ?? 0;
  const chromeOffset = showGridChrome ? HEADER_HEIGHT : 0;
  const chromeBorder = showGridChrome
    ? { borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }
    : {};
  const frozenRow = freezeHeader ? rowsByIndex.get(0) : undefined;

  return (
    <div
      ref={containerRef}
      data-gigagrid-scroll
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={handleKeyDown}
      style={{ overflow: "auto", height: "100%", position: "relative", outline: "none", userSelect: "none" }}
    >
      {showGridChrome && (
        <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 3, background: "var(--header-bg)" }}>
          <div
            style={{
              position: "sticky",
              left: 0,
              zIndex: 4,
              flexShrink: 0,
              minWidth: GUTTER_WIDTH,
              height: HEADER_HEIGHT,
              background: "var(--header-bg)",
              ...chromeBorder,
            }}
          />
          {Array.from({ length: colCount }, (_, c) => (
            <div
              key={c}
              onMouseDown={(e) => {
                e.preventDefault();
                if (e.shiftKey && selStart) {
                  setSelEnd({ row: rowCount - 1, col: c });
                } else {
                  setSelStart({ row: 0, col: c });
                  setSelEnd({ row: rowCount - 1, col: c });
                }
                containerRef.current?.focus();
              }}
              style={{
                position: "relative",
                flexShrink: 0,
                width: colWidths[c] ?? DEFAULT_COL_WIDTH,
                height: HEADER_HEIGHT,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                ...chromeBorder,
              }}
            >
              {c + 1}
              <div
                onMouseDown={(e) => startColResize(e, c)}
                style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 4, cursor: "col-resize" }}
              />
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
            background: "var(--header-bg)",
          }}
        >
          {showGridChrome && (
            <div
              style={{
                position: "sticky",
                left: 0,
                zIndex: 4,
                flexShrink: 0,
              minWidth: GUTTER_WIDTH,
                background: "var(--header-bg)",
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
            <div key={ci} style={{ position: "relative", flexShrink: 0, width: colWidths[ci] ?? DEFAULT_COL_WIDTH, ...chromeBorder }}>
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
      <div style={{ height: totalHeight, position: "relative" }}>
        {Array.from({ length: range.count }, (_, i) => {
          const offset = range.start + i;
          const rowIndex = freezeHeader ? offset + 1 : offset;
          const row = rowsByIndex.get(rowIndex);
          return (
            <div
              key={rowIndex}
              style={{
                position: "absolute",
                top: offset * rowHeight,
                height: rowHeight,
                display: "flex",
                width: "100%",
                zIndex: editingRow === rowIndex ? 5 : undefined,
              }}
            >
              {showGridChrome && (
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (e.shiftKey && selStart) {
                      setSelEnd({ row: rowIndex, col: colCount - 1 });
                    } else {
                      setSelStart({ row: rowIndex, col: 0 });
                      setSelEnd({ row: rowIndex, col: colCount - 1 });
                    }
                    containerRef.current?.focus();
                  }}
                  style={{
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    flexShrink: 0,
                    minWidth: GUTTER_WIDTH,
                    background: "var(--header-bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    ...chromeBorder,
                  }}
                >
                  {rowIndex + 1}
                  <div
                    onMouseDown={startRowResize}
                    style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 4, cursor: "row-resize" }}
                  />
                </div>
              )}
              {row
                ? row.map((cell, ci) => (
                    <div
                      key={ci}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (e.shiftKey && selStart) {
                          setSelEnd({ row: rowIndex, col: ci });
                        } else {
                          startSelect(rowIndex, ci);
                        }
                      }}
                      onMouseEnter={() => extendSelect(rowIndex, ci)}
                      style={{
                        position: "relative",
                        flexShrink: 0,
                        width: colWidths[ci] ?? DEFAULT_COL_WIDTH,
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
