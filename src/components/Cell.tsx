import { useEffect, useRef, useState } from "react";

const MAX_WIDTH = 400;
const MAX_HEIGHT = 240;

interface CellProps {
  value: string;
  onCommit: (value: string) => void;
  onOverflow?: () => void;
  onEditingChange?: (editing: boolean) => void;
}

/** One editable cell: double-click/Enter to edit, Enter/blur to commit,
 * Escape to cancel. Editing uses a textarea that auto-grows to fit content
 * (up to MAX_WIDTH/MAX_HEIGHT, then scrolls internally) — Shift+Enter inserts
 * a newline, plain Enter still commits. While editing, reports whether the
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
    el.style.width = "auto";
    el.style.height = "auto";
    const scrollEl = el.closest<HTMLElement>("[data-gigagrid-scroll]");
    const availableToEdge = scrollEl
      ? scrollEl.getBoundingClientRect().right - el.getBoundingClientRect().left - 4
      : MAX_WIDTH;
    const widthCap = Math.max(MAX_WIDTH, availableToEdge);
    const wantedWidth = Math.min(widthCap, Math.max(100, el.scrollWidth));
    const wantedHeight = Math.min(MAX_HEIGHT, Math.max(28, el.scrollHeight));
    el.style.width = `${wantedWidth}px`;
    el.style.height = `${wantedHeight}px`;
    if (el.scrollWidth > wantedWidth || el.scrollHeight > wantedHeight) {
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
        style={{ position: "absolute", zIndex: 1, boxSizing: "border-box", resize: "none" }}
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
