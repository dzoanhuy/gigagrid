export interface GridStats {
  totalCols: number;
  cursor: { row: number; col: number } | null;
  selection: { rows: number; cols: number } | null;
}

interface StatusBarProps {
  totalRows: number;
  stats: GridStats;
}

export function StatusBar({ totalRows, stats }: StatusBarProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "2px 8px",
        borderTop: "1px solid var(--border)",
        fontSize: 12,
        lineHeight: "16px",
        opacity: 0.8,
        flexShrink: 0,
      }}
    >
      <span>{totalRows.toLocaleString()} rows</span>
      <span>{stats.totalCols} cols</span>
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
  );
}
