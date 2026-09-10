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
}

export function StatusBar({ file, stats }: StatusBarProps) {
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
      <div style={{ display: "flex", gap: 16, flexShrink: 0 }}>
        <span>{file.row_count.toLocaleString()} rows</span>
        <span>{stats.totalCols} cols</span>
        <span>{file.format}</span>
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
