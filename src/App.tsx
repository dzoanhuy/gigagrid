import "./App.css";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Grid, type GridHandle } from "./components/Grid";
import { Toolbar, type ToolbarHandle } from "./components/Toolbar";
import { StatusBar, type GridStats } from "./components/StatusBar";
import { loadSettings, saveSettings, type Settings, type Theme } from "./settings";

interface FileMeta {
  path: string;
  row_count: number;
  format: string;
  encoding: string;
  line_ending: string;
}

function App() {
  const [file, setFile] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [stats, setStats] = useState<GridStats>({ totalCols: 0, cursor: null, selection: null });
  const [showSearch, setShowSearch] = useState(false);
  const gridRef = useRef<GridHandle>(null);
  const toolbarRef = useRef<ToolbarHandle>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !file) return;
      if (e.key === "f") {
        e.preventDefault();
        setShowSearch((prev) => {
          const next = !prev;
          if (next) window.setTimeout(() => toolbarRef.current?.focusSearch(), 0);
          return next;
        });
      } else if (e.key === "g") {
        e.preventDefault();
        if (!showSearch) return;
        if (e.shiftKey) toolbarRef.current?.findPrev();
        else toolbarRef.current?.findNext();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [file, showSearch]);

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
    if (col !== undefined) {
      gridRef.current?.selectCell(row, col);
    } else {
      gridRef.current?.scrollToRow(row);
    }
  }

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ padding: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
        {file && <Toolbar ref={toolbarRef} visible={showSearch} onNavigate={handleNavigate} />}
        {savedAt && <span style={{ opacity: 0.6 }}>Saved {savedAt.toLocaleTimeString()}</span>}
        {error && <span style={{ color: "red" }}>{error}</span>}
      </div>
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
      {file && <StatusBar file={file} stats={stats} />}
    </main>
  );
}

export default App;
