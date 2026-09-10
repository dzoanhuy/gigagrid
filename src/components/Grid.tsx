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
const COPY_CHUNK_ROWS = 5000;

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

/**
 * Fetches `count` rows starting at `start` via `fetchChunk`, split into
 * `chunkSize`-sized round trips instead of one big call — a selection of
 * hundreds of thousands of rows fetched in a single `get_rows` invoke means
 * a single Tauri IPC response tens of MB wide, which is exactly the kind of
 * payload the IPC transport can choke on (rows silently coming back blank
 * rather than a clean error). No IPC, no state — unit-testable in isolation
 * against a fake `fetchChunk`, same pattern as `computeWindow`.
 */
export async function fetchRowsInChunks(
  start: number,
  count: number,
  chunkSize: number,
  fetchChunk: (chunkStart: number, chunkCount: number) => Promise<string[][]>,
): Promise<string[][]> {
  const allRows: string[][] = [];
  for (let offset = 0; offset < count; offset += chunkSize) {
    const chunkCount = Math.min(chunkSize, count - offset);
    const chunk = await fetchChunk(start + offset, chunkCount);
    allRows.push(...chunk);
  }
  return allRows;
}

interface GridProps {
  tabId: number;
  rowCount: number;
  showGridChrome: boolean;
  freezeHeader: boolean;
  onStatsChange?: (stats: GridStats) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onError?: (message: string | null) => void;
}

export interface GridHandle {
  scrollToRow: (row: number) => void;
  scrollToCol: (col: number) => void;
  selectCell: (row: number, col: number) => void;
  invalidateCache: () => void;
}

interface CellPos {
  row: number;
  col: number;
}

export const Grid = forwardRef<GridHandle, GridProps>(function Grid({ tabId, rowCount, showGridChrome, freezeHeader, onStatsChange, onDirtyChange, onError }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fetchTimer = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowsByIndex, setRowsByIndex] = useState<Map<number, string[]>>(new Map());
  const [selStart, setSelStart] = useState<CellPos | null>(null);
  const [selEnd, setSelEnd] = useState<CellPos | null>(null);
  const [editingCell, setEditingCell] = useState<CellPos | null>(null);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT);
  // App.tsx passes an inline `(stats) => updateTab(...)` — a new function
  // identity every App render, independent of whether selection/data
  // actually changed. Reading it through a ref (instead of putting it in
  // the stats-effect's own deps below) means that effect only re-runs when
  // the SELECTION/DATA changes, not on every App render — including the
  // App render its own last call just triggered, which previously formed
  // an infinite effect->setState->render->effect loop ("Maximum update
  // depth exceeded").
  const onStatsChangeRef = useRef(onStatsChange);
  useEffect(() => {
    onStatsChangeRef.current = onStatsChange;
  });
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

  // Shared by the imperative handle (goto/search) and keyboard navigation
  // (arrow keys) — every caller that moves the cursor/selection needs the
  // new position scrolled into view the same way.
  // Scrolls (row, col) into view ONLY if it isn't already fully visible —
  // an unconditional snap-to-position on every arrow-key press (the
  // original behavior) re-centers the viewport even when the target cell
  // was already on screen, which reads as the grid scrolling on its own
  // for no reason. `topCover`/`leftCover` account for the sticky
  // header/frozen-row bar and row-number gutter visually covering part of
  // the scrollable area even though it's still within scrollTop/scrollLeft
  // range — a cell freshly scrolled to `visibleTop` would otherwise sit
  // right underneath those bars, invisible.
  function scrollCellIntoView(row: number, col: number) {
    const el = containerRef.current;
    if (!el) return;
    const offset = freezeHeader ? Math.max(0, row - 1) : row;
    // rows/cells render inside a wrapper that sits AFTER the sticky
    // header/gutter in normal flow — those bars still consume real flow
    // space even though they're pinned visually, so a row/col's actual
    // position within the scrollable content is offset by topCover/leftCover,
    // not just the local offset*rowHeight / summed colWidths. Omitting this
    // here previously under-scrolled by exactly that many px, leaving the
    // target cell still clipped at the bottom/right edge after "jumping" to it.
    const topCover = (showGridChrome ? HEADER_HEIGHT : 0) + (freezeHeader ? HEADER_HEIGHT : 0);
    const rowTop = topCover + offset * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const visibleTop = el.scrollTop + topCover;
    const visibleBottom = el.scrollTop + el.clientHeight;
    if (rowTop < visibleTop) {
      el.scrollTop = rowTop - topCover;
    } else if (rowBottom > visibleBottom) {
      el.scrollTop = rowBottom - el.clientHeight;
    }

    const leftCover = showGridChrome ? GUTTER_WIDTH : 0;
    let colLeft = leftCover;
    for (let c = 0; c < col; c++) colLeft += colWidths[c] ?? DEFAULT_COL_WIDTH;
    const colRight = colLeft + (colWidths[col] ?? DEFAULT_COL_WIDTH);
    const visibleLeft = el.scrollLeft + leftCover;
    const visibleRight = el.scrollLeft + el.clientWidth;
    if (colLeft < visibleLeft) {
      el.scrollLeft = colLeft - leftCover;
    } else if (colRight > visibleRight) {
      el.scrollLeft = colRight - el.clientWidth;
    }
  }

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
      scrollCellIntoView(row, col);
    },
    invalidateCache,
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
      invoke<string[][]>("get_rows", { tabId, start: fetchStart, count: range.count }).then(
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
    invoke<string[][]>("get_rows", { tabId, start: 0, count: 1 }).then((rows) => {
      if (!rows[0]) return;
      setRowsByIndex((prev) => new Map(prev).set(0, rows[0]));
    });
  }, [freezeHeader, rowCount]);

  function commitCell(rowIndex: number, colIndex: number, value: string) {
    invoke("set_cell", { tabId, row: rowIndex, col: colIndex, value }).then(() => {
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
      onDirtyChange?.(true);
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
    onStatsChangeRef.current?.({
      totalCols: colCount,
      cursor: selEnd,
      selection: b ? { rows: b.rowMax - b.rowMin + 1, cols: b.colMax - b.colMin + 1 } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selStart, selEnd, rowsByIndex]);

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

  // Single entry point for "start editing this cell" — used by both Enter
  // (on whatever is currently selected) and a cell's own double-click, so
  // both paths agree on collapsing the selection the same way: an open edit
  // box replaces the multi-cell highlight with the single cell being typed
  // into, and becomes the new anchor for navigation once editing ends.
  function requestEdit(row: number, col: number) {
    setEditingCell({ row, col });
    setSelStart({ row, col });
    setSelEnd({ row, col });
  }

  function endEdit() {
    setEditingCell(null);
    // Deferred: focusing the container SYNCHRONOUSLY here (still inside the
    // textarea's own commit/cancel call) would blur the still-mounted
    // textarea, re-firing its onBlur=commit reentrantly before this call
    // even returns — a second, spurious onCommit. Waiting a tick lets
    // React unmount the textarea first, so there's nothing left to blur.
    window.setTimeout(() => containerRef.current?.focus(), 0);
  }

  // Applying an undo/redo can touch cells anywhere in the file (including
  // rows outside the currently cached window) — the simplest CORRECT thing
  // is to drop the local cache entirely and let the existing "missing rows"
  // fetch effect reload the visible window with fresh overlay-merged data,
  // rather than trying to patch the cache with exactly what changed.
  function invalidateCache() {
    setRowsByIndex(new Map());
  }

  function copySelection() {
    const b = selectionBounds();
    if (!b) return Promise.resolve();
    // Never read from `rowsByIndex` here — it only holds whatever the
    // virtualized viewport has scrolled through, which for a selection
    // that spans far beyond the visible window is nearly all of it: most
    // rows would silently copy as empty. Fetch fresh from the backend
    // instead (this also merges the overlay, same as every other read
    // path), chunked (see fetchRowsInChunks).
    const textPromise = (async () => {
      const totalRows = b.rowMax - b.rowMin + 1;
      const allRows = await fetchRowsInChunks(b.rowMin, totalRows, COPY_CHUNK_ROWS, (s, c) =>
        invoke<string[][]>("get_rows", { tabId, start: s, count: c }),
      );
      const lines: string[] = [];
      for (const row of allRows) {
        const cells: string[] = [];
        for (let c = b.colMin; c <= b.colMax; c++) {
          cells.push(row?.[c] ?? "");
        }
        lines.push(cells.join("\t"));
      }
      return new Blob([lines.join("\n")], { type: "text/plain" });
    })();
    // `navigator.clipboard.write` (NOT `.writeText`) MUST be called
    // synchronously, right here, with no `await` before it — clipboard
    // writes require a still-live "user activation" from the triggering
    // Cmd/Ctrl+C keydown, which expires while a large selection's chunked
    // fetch is still in flight. `writeText` needs the STRING up front (so
    // the old code only called it after every chunk resolved, well past
    // that window — "NotAllowedError: ... possibly because the user denied
    // permission" for any selection slow enough to fetch). Passing a
    // ClipboardItem whose value is a *pending* Blob promise is the
    // documented way to reserve the write against the CURRENT activation
    // while the actual content is still being prepared.
    return navigator.clipboard
      .write([new ClipboardItem({ "text/plain": textPromise })])
      .then(() => onError?.(null))
      .catch((err) => {
        onError?.(`Copy failed: ${err}`);
      });
  }

  async function pasteSelection() {
    const b = selectionBounds();
    if (!b) return;
    try {
      const text = await navigator.clipboard.readText();
      const grid = text.replace(/\r/g, "").split("\n").map((line) => line.split("\t"));
      const edits: [number, number, string][] = [];
      grid.forEach((line, ri) => {
        line.forEach((value, ci) => {
          edits.push([b.rowMin + ri, b.colMin + ci, value]);
        });
      });
      if (edits.length === 0) return;
      // Same reasoning as copySelection: a paste of hundreds of thousands
      // of cells in one set_cells_batch call is a single huge IPC payload
      // — chunk it so no single round trip is unreasonably large.
      for (let offset = 0; offset < edits.length; offset += COPY_CHUNK_ROWS) {
        const batch = edits.slice(offset, offset + COPY_CHUNK_ROWS);
        await invoke("set_cells_batch", { tabId, edits: batch });
      }
      onDirtyChange?.(true);
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
      onError?.(null);
    } catch (err) {
      onError?.(`Paste failed: ${err}`);
    }
  }

  async function handleKeyDown(e: React.KeyboardEvent) {
    // A cell being edited owns the keyboard outright — arrow keys move its
    // caret, Cmd+A selects its text, Cmd+C/V work on its selection, etc.
    // The keydown still bubbles up here from the `<textarea>` (it doesn't
    // stop propagation), so every grid-level shortcut below must yield to
    // it rather than hijack the field.
    if (editingCell) return;

    const mod = e.metaKey || e.ctrlKey;
    const isArrow =
      e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight";

    // Arrow-key navigation (Excel-style) runs regardless of Cmd/Ctrl/Shift —
    // handled FIRST, before the `if (!mod) return` gate below, since plain
    // arrows and Shift+arrows carry no modifier at all.
    if (isArrow) {
      e.preventDefault();
      const anchor = selStart ?? { row: 0, col: 0 };
      const current = selEnd ?? { row: 0, col: 0 };
      const target = { ...current };
      if (mod) {
        // Cmd/Ctrl+Arrow — jump straight to the edge. When freezeHeader is
        // on, row 0 is pinned as a title row (always visible regardless of
        // scroll) — "jump to top" should land on the first row of actual
        // data below it (row 1), not re-select the title row itself. Same
        // target used for both the plain jump and Cmd+Shift+Up's extend
        // (computed once below, branched into collapse-vs-extend after).
        if (e.key === "ArrowUp") target.row = freezeHeader ? Math.min(1, Math.max(0, rowCount - 1)) : 0;
        else if (e.key === "ArrowDown") target.row = rowCount - 1;
        else if (e.key === "ArrowLeft") target.col = 0;
        else if (e.key === "ArrowRight") target.col = Math.max(0, colCount - 1);
      } else {
        // Plain Arrow — move one cell.
        if (e.key === "ArrowUp") target.row = Math.max(0, current.row - 1);
        else if (e.key === "ArrowDown") target.row = Math.min(rowCount - 1, current.row + 1);
        else if (e.key === "ArrowLeft") target.col = Math.max(0, current.col - 1);
        else if (e.key === "ArrowRight") target.col = Math.min(Math.max(0, colCount - 1), current.col + 1);
      }
      if (e.shiftKey) {
        // Shift(+Cmd/Ctrl)+Arrow — extend the selection: anchor stays put,
        // only the far corner moves.
        setSelStart(anchor);
        setSelEnd(target);
      } else {
        // Plain/Cmd+Arrow with no Shift — move the cursor: collapse the
        // selection to the single target cell.
        setSelStart(target);
        setSelEnd(target);
      }
      scrollCellIntoView(target.row, target.col);
      return;
    }

    if (e.key === "Enter" && !mod) {
      // Edit whatever the selection is currently anchored on — with a
      // multi-cell range selected, that's the last-selected cell (selEnd),
      // not the range's origin.
      e.preventDefault();
      const target = selEnd ?? selStart;
      if (target) requestEdit(target.row, target.col);
      return;
    }

    if (!mod) return;
    if (e.key === "c") {
      e.preventDefault();
      await copySelection();
    } else if (e.key === "v") {
      e.preventDefault();
      await pasteSelection();
    } else if (e.key === "z" && e.shiftKey) {
      e.preventDefault();
      await invoke("redo", { tabId });
      invalidateCache();
    } else if (e.key === "z") {
      e.preventDefault();
      await invoke("undo", { tabId });
      invalidateCache();
    } else if (e.key === "a") {
      e.preventDefault();
      setSelStart({ row: 0, col: 0 });
      setSelEnd({ row: rowCount - 1, col: Math.max(0, colCount - 1) });
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
        <div
          style={{
            display: "flex",
            width: "fit-content",
            position: "sticky",
            top: 0,
            zIndex: 3,
            background: "var(--header-bg)",
          }}
        >
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
            width: "fit-content",
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
                editing={editingCell?.row === 0 && editingCell?.col === ci}
                onRequestEdit={() => requestEdit(0, ci)}
                onCommit={(v) => commitCell(0, ci, v)}
                onOverflow={() => handleOverflow(0)}
                onEditEnd={endEdit}
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
                zIndex: editingCell?.row === rowIndex ? 5 : undefined,
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
                        // A mousedown on this cell's own <textarea> while it's
                        // being edited (e.g. dragging its internal scrollbar
                        // thumb) still bubbles up to this wrapper — stealing
                        // focus back to the grid container here would blur the
                        // textarea and commit/close the edit mid-drag.
                        if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
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
                        editing={editingCell?.row === rowIndex && editingCell?.col === ci}
                        onRequestEdit={() => requestEdit(rowIndex, ci)}
                        onCommit={(v) => commitCell(rowIndex, ci, v)}
                        onOverflow={() => handleOverflow(rowIndex)}
                        onEditEnd={endEdit}
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
