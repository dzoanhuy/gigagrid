import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Grid, type GridHandle } from "./components/Grid";
import { Toolbar } from "./components/Toolbar";

interface FileMeta {
  path: string;
  row_count: number;
}

function App() {
  const [file, setFile] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gridRef = useRef<GridHandle>(null);

  async function openFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const meta = await invoke<FileMeta>("open_file", { path: selected });
      setError(null);
      setFile(meta);
    } catch (e) {
      setError(String(e));
    }
  }

  function handleNavigate(row: number, col?: number) {
    gridRef.current?.scrollToRow(row);
    if (col !== undefined) gridRef.current?.scrollToCol(col);
  }

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ padding: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={openFile}>Open file</button>
        {file && (
          <span>
            {file.path} — {file.row_count.toLocaleString()} rows
          </span>
        )}
        {error && <span style={{ color: "red" }}>{error}</span>}
      </div>
      {file && <Toolbar onNavigate={handleNavigate} />}
      <div style={{ flex: 1, minHeight: 0 }}>
        {file && <Grid ref={gridRef} rowCount={file.row_count} />}
      </div>
    </main>
  );
}

export default App;
