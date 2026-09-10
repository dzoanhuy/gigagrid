import { useEffect, useRef, useState } from "react";

const MIN_WIDTH = 100;
const MIN_HEIGHT = 28;
const EDGE_MARGIN = 4;

interface CellProps {
  value: string;
  onCommit: (value: string) => void;
  onOverflow?: () => void;
  onEditingChange?: (editing: boolean) => void;
}

/** One editable cell: double-click/Enter to edit, Enter/blur to commit,
 * Escape to cancel. Editing uses a textarea that auto-grows to fit content,
 * up to whatever space is left in the grid area (to its right/bottom edge —
 * not a small fixed cap), then scrolls internally — Shift+Enter inserts a
 * newline, plain Enter still commits. While editing, reports whether the
 * content still overflows the grown box so the parent Grid can auto-scroll
 * to reveal it. */
export function Cell({ value, onCommit, onOverflow, onEditingChange }: CellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    const scrollEl = el.closest<HTMLElement>("[data-gigagrid-scroll]");
    const cellRect = el.getBoundingClientRect();
    const scrollRect = scrollEl?.getBoundingClientRect();
    const availableWidth = scrollRect
      ? Math.max(MIN_WIDTH, scrollRect.right - cellRect.left - EDGE_MARGIN)
      : MIN_WIDTH;
    const availableHeight = scrollRect
      ? Math.max(MIN_HEIGHT, scrollRect.bottom - cellRect.top - EDGE_MARGIN)
      : MIN_HEIGHT;
    // Never start narrower than the column's own (possibly user-resized)
    // width — only the min-content floor (100px) doesn't know about that.
    const columnWidth = el.parentElement?.getBoundingClientRect().width ?? MIN_WIDTH;
    const widthFloor = Math.max(MIN_WIDTH, columnWidth);

    // Pass 1: measure the content's UNWRAPPED natural width — with wrapping
    // on (the default), a long single line just wraps at whatever narrow
    // width the box already has and scrollWidth never reflects how wide the
    // content actually wants to be, so width silently never grows.
    el.style.whiteSpace = "pre";
    el.style.width = "auto";
    el.style.height = "auto";
    const naturalWidth = el.scrollWidth;
    const wantedWidth = Math.min(availableWidth, Math.max(widthFloor, naturalWidth));

    // Pass 2: lock the width, restore wrapping, then measure height against
    // THAT width (wrapped line count depends on the width just chosen).
    el.style.whiteSpace = "pre-wrap";
    el.style.width = `${wantedWidth}px`;
    el.style.height = "auto";
    const naturalHeight = el.scrollHeight;
    const wantedHeight = Math.min(availableHeight, Math.max(MIN_HEIGHT, naturalHeight));
    el.style.height = `${wantedHeight}px`;

    if (naturalWidth > wantedWidth || naturalHeight > wantedHeight) {
      onOverflow?.();
    }
  }, [editing, draft, onOverflow]);

  function commit() {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  if (editing) {
    return (
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") cancel();
        }}
        style={{
          position: "absolute",
          zIndex: 1,
          boxSizing: "border-box",
          resize: "none",
          font: "inherit",
          color: "var(--fg)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
        }}
      />
    );
  }

  return (
    <div
      onDoubleClick={() => setEditing(true)}
      style={{
        padding: "0 6px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        width: "100%",
      }}
    >
      {value}
    </div>
  );
}
