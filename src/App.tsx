import "./App.css";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Grid, type GridHandle } from "./components/Grid";
import { Toolbar } from "./components/Toolbar";
import { StatusBar, type GridStats } from "./components/StatusBar";
import { loadSettings, saveSettings, type Settings, type Theme } from "./settings";

interface FileMeta {
  path: string;
  row_count: number;
}

function App() {
  const [file, setFile] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [stats, setStats] = useState<GridStats>({ totalCols: 0, cursor: null, selection: null });
  const gridRef = useRef<GridHandle>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  function updateSettings(patch: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }

  async function openFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const meta = await invoke<FileMeta>("open_file", { path: selected });
      setError(null);
      setSavedAt(null);
      setFile(meta);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveFile() {
    setSaving(true);
    try {
      await invoke("save_file", { dst: null });
      setError(null);
      setSavedAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
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
        <select
          value={settings.theme}
          onChange={(e) => updateSettings({ theme: e.currentTarget.value as Theme })}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={settings.showGridChrome}
            onChange={(e) => updateSettings({ showGridChrome: e.currentTarget.checked })}
          />
          Grid
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.freezeHeader}
            onChange={(e) => updateSettings({ freezeHeader: e.currentTarget.checked })}
          />
          Freeze header
        </label>
        {file && (
          <button onClick={saveFile} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        {file && (
          <span>
            {file.path} — {file.row_count.toLocaleString()} rows
          </span>
        )}
        {savedAt && <span style={{ opacity: 0.6 }}>Saved {savedAt.toLocaleTimeString()}</span>}
        {error && <span style={{ color: "red" }}>{error}</span>}
      </div>
      {file && <Toolbar onNavigate={handleNavigate} />}
      <div style={{ flex: 1, minHeight: 0 }}>
        {file && (
          <Grid
            key={file.path}
            ref={gridRef}
            rowCount={file.row_count}
            showGridChrome={settings.showGridChrome}
            freezeHeader={settings.freezeHeader}
            onStatsChange={setStats}
          />
        )}
      </div>
      {file && <StatusBar totalRows={file.row_count} stats={stats} />}
    </main>
  );
}

export default App;
