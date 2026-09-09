import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_DEBOUNCE_MS = 50;
const MAX_CACHE_ROWS = 20000;

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
}

export function Grid({ rowCount }: GridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fetchTimer = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowsByIndex, setRowsByIndex] = useState<Map<number, string[]>>(new Map());

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  const totalHeight = rowCount * ROW_HEIGHT;

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ overflow: "auto", height: "100%", position: "relative" }}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {Array.from({ length: range.count }, (_, i) => {
          const rowIndex = range.start + i;
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
              }}
            >
              {row
                ? row.map((cell, ci) => (
                    <div key={ci} style={{ padding: "0 6px", whiteSpace: "nowrap" }}>
                      {cell}
                    </div>
                  ))
                : <div style={{ padding: "0 6px", opacity: 0.4 }}>…</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
