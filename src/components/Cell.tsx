import { useEffect, useRef, useState } from "react";

interface CellProps {
  value: string;
  onCommit: (value: string) => void;
  onOverflow?: () => void;
}

/** One editable cell: double-click/Enter to edit, Enter/blur to commit,
 * Escape to cancel. While editing, reports whether the input's content
 * overflows its own box so the parent Grid can auto-scroll to reveal it. */
export function Cell({ value, onCommit, onOverflow }: CellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) {
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
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") cancel();
        }}
        style={{ width: "100%", boxSizing: "border-box" }}
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
