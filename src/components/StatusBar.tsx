import { useState, useEffect } from "react";

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
  onReopenWithEncoding?: (encoding: string) => void;
  onChangeFormat?: (format: "CSV" | "TSV") => void;
  onChangeLineEnding?: (lineEnding: "LF" | "CRLF") => void;
}

export function StatusBar({
  file,
  stats,
  error,
  onReopenWithDelimiter,
  onReopenWithEncoding,
  onChangeFormat,
  onChangeLineEnding,
}: StatusBarProps) {
  const [showDelim, setShowDelim] = useState(false);
  const [showEnc, setShowEnc] = useState(false);
  const [showLineEnding, setShowLineEnding] = useState(false);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!(e.target as HTMLElement)?.closest(".status-popover-anchor")) {
        setShowDelim(false);
        setShowEnc(false);
        setShowLineEnding(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setShowDelim(false);
        setShowEnc(false);
        setShowLineEnding(false);
      }
    }
    window.addEventListener("click", onDocClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", onDocClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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
        <span style={{ position: "relative" }} className="status-popover-anchor">
          <span
            style={{ cursor: "pointer" }}
            onClick={() => {
              setShowDelim((v) => !v);
              setShowEnc(false);
              setShowLineEnding(false);
            }}
            title="Click to switch format (CSV/TSV) or reopen with delimiter"
          >
            {file.format}
          </span>
          {showDelim && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                zIndex: 10,
                display: "flex",
                flexDirection: "column",
                minWidth: 170,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                padding: 4,
                gap: 2,
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.7, padding: "2px 6px", fontWeight: 600 }}>
                Format
              </div>
              {[
                ["CSV (Comma ,)", "CSV"],
                ["TSV (Tab \\t)", "TSV"],
              ].map(([label, fmt]) => {
                const isCurrent = file.format === fmt;
                return (
                  <button
                    key={fmt}
                    onClick={() => {
                      setShowDelim(false);
                      onChangeFormat?.(fmt as "CSV" | "TSV");
                    }}
                    style={{
                      textAlign: "left",
                      fontWeight: isCurrent ? 700 : "normal",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>{label}</span>
                    {isCurrent && <span style={{ fontSize: 10, opacity: 0.7 }}>✓</span>}
                  </button>
                );
              })}

              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  marginTop: 4,
                  paddingTop: 4,
                  fontSize: 11,
                  opacity: 0.7,
                  paddingLeft: 6,
                  paddingRight: 6,
                  fontWeight: 600,
                }}
              >
                Reopen raw file as...
              </div>
              {[
                ["Comma (,)", ","],
                ["Tab (\\t)", "\t"],
                ["Semicolon (;)", ";"],
                ["Pipe (|)", "|"],
              ].map(([label, d]) => (
                <button
                  key={d}
                  onClick={() => {
                    setShowDelim(false);
                    onReopenWithDelimiter?.(d);
                  }}
                  style={{ textAlign: "left" }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </span>
        <span style={{ position: "relative" }} className="status-popover-anchor">
          <span
            style={{ cursor: onReopenWithEncoding ? "pointer" : undefined }}
            onClick={() => {
              setShowEnc((v) => !v);
              setShowDelim(false);
              setShowLineEnding(false);
            }}
            title="Click to switch encoding"
          >
            {file.encoding}
          </span>
          {showEnc && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                zIndex: 10,
                display: "flex",
                flexDirection: "column",
                minWidth: 150,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                padding: 4,
                gap: 2,
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.7, padding: "2px 6px", fontWeight: 600 }}>
                Encoding
              </div>
              {[
                ["Auto-Detect", "auto"],
                ["UTF-8", "utf-8"],
                ["Shift-JIS", "shift_jis"],
                ["EUC-JP", "euc-jp"],
                ["Windows-1252", "windows-1252"],
                ["GB18030", "gb18030"],
                ["Big5", "big5"],
                ["EUC-KR", "euc-kr"],
              ].map(([label, enc]) => {
                const isCurrent =
                  enc === "auto"
                    ? false
                    : file.encoding.toLowerCase().replace(/[-_]/g, "") ===
                      enc.toLowerCase().replace(/[-_]/g, "");
                return (
                  <button
                    key={enc}
                    onClick={() => {
                      setShowEnc(false);
                      onReopenWithEncoding?.(enc);
                    }}
                    style={{
                      textAlign: "left",
                      fontWeight: isCurrent ? 700 : "normal",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>{label}</span>
                    {isCurrent && <span style={{ fontSize: 10, opacity: 0.7 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </span>
        <span style={{ position: "relative" }} className="status-popover-anchor">
          <span
            style={{ cursor: onChangeLineEnding ? "pointer" : undefined }}
            onClick={() => {
              setShowLineEnding((v) => !v);
              setShowDelim(false);
              setShowEnc(false);
            }}
            title="Click to switch line ending"
          >
            {file.line_ending}
          </span>
          {showLineEnding && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                zIndex: 10,
                display: "flex",
                flexDirection: "column",
                minWidth: 160,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                padding: 4,
                gap: 2,
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.7, padding: "2px 6px", fontWeight: 600 }}>
                Line Ending
              </div>
              {[
                ["LF (Unix / macOS - \\n)", "LF"],
                ["CRLF (Windows - \\r\\n)", "CRLF"],
              ].map(([label, le]) => {
                const isCurrent = file.line_ending.toUpperCase() === le;
                return (
                  <button
                    key={le}
                    onClick={() => {
                      setShowLineEnding(false);
                      onChangeLineEnding?.(le as "LF" | "CRLF");
                    }}
                    style={{
                      textAlign: "left",
                      fontWeight: isCurrent ? 700 : "normal",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>{label}</span>
                    {isCurrent && <span style={{ fontSize: 10, opacity: 0.7 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </span>
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
