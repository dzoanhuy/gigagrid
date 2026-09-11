import { useState } from "react";

export interface GridStats {
  totalCols: number;
  cursor: { row: number; col: number } | null;
  selection: { rows: number; cols: number } | null;
}

export interface StatusFile {
  path: string;
  row_count: number;
  format: string;
  encoding: string;
  line_ending: string;
}

interface StatusBarProps {
  file: StatusFile;
  stats: GridStats;
  error?: string | null;
  onReopenWithDelimiter?: (delimiter: string) => void;
}

export function StatusBar({ file, stats, error, onReopenWithDelimiter }: StatusBarProps) {
  const [showDelim, setShowDelim] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        padding: "2px 8px",
        borderTop: "1px solid var(--border)",
        fontSize: 12,
        lineHeight: "16px",
        opacity: 0.8,
        flexShrink: 0,
        overflow: "hidden",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }} title={file.path}>
        {file.path}
      </span>
      {error && (
        <span
          style={{ color: "red", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
          title={error}
        >
          {error}
        </span>
      )}
      <div style={{ display: "flex", gap: 16, flexShrink: 0 }}>
        <span>{file.row_count.toLocaleString()} rows</span>
        <span>{stats.totalCols} cols</span>
        <span style={{ position: "relative" }}>
          <span style={{ cursor: onReopenWithDelimiter ? "pointer" : undefined }} onClick={() => setShowDelim((v) => !v)}>
            {file.format}
          </span>
          {showDelim && (
            <div style={{ position: "absolute", bottom: "100%", left: 0, zIndex: 10, display: "flex", flexDirection: "column", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, padding: 4 }}>
              {[["Comma", ","], ["Tab", "\t"], ["Semicolon", ";"], ["Pipe", "|"]].map(([label, d]) => (
                <button key={label} onClick={() => { setShowDelim(false); onReopenWithDelimiter?.(d); }}>{label}</button>
              ))}
            </div>
          )}
        </span>
        <span>{file.encoding}</span>
        <span>{file.line_ending}</span>
        {stats.cursor && (
          <span>
            cursor: R{stats.cursor.row + 1}, C{stats.cursor.col + 1}
          </span>
        )}
        {stats.selection && stats.selection.rows * stats.selection.cols > 1 && (
          <span>
            selection: {stats.selection.rows} × {stats.selection.cols}
          </span>
        )}
      </div>
    </div>
  );
}
