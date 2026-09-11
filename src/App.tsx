import "./App.css";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Grid, type GridHandle } from "./components/Grid";
import { Toolbar, type ToolbarHandle } from "./components/Toolbar";
import { StatusBar, type GridStats } from "./components/StatusBar";
import { loadSettings, saveSettings, pushRecentFile, type Settings, type Theme } from "./settings";
import { IconFolder, IconSave, IconMonitor, IconSun, IconMoon, IconGrid, IconPin, IconDownload, IconClock } from "./icons";

const MAX_TABS = 10;

interface FileMeta {
  tab_id: number;
  path: string;
  row_count: number;
  format: string;
  encoding: string;
  line_ending: string;
}

interface Tab {
  meta: FileMeta;
  error: string | null;
  saving: boolean;
  savedAt: Date | null;
  stats: GridStats;
  showSearch: boolean;
  dirty: boolean;
  filterActive: boolean;
  sortActive: boolean;
}

const EMPTY_STATS: GridStats = { totalCols: 0, cursor: null, selection: null };

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [updateBusy, setUpdateBusy] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const gridRefs = useRef<Map<number, GridHandle>>(new Map());
  const toolbarRefs = useRef<Map<number, ToolbarHandle>>(new Map());

  const activeTab = tabs.find((t) => t.meta.tab_id === activeTabId) ?? null;

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    invoke<string | null>("take_pending_open").then((path) => {
      if (path) openFileAsNewTab(path);
    });
    const unlisten = listen<string>("open-file", (event) => {
      openFileAsNewTab(event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleSearch(tabId: number) {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.meta.tab_id !== tabId) return t;
        const next = !t.showSearch;
        if (next) window.setTimeout(() => toolbarRefs.current.get(tabId)?.focusSearch(), 0);
        return { ...t, showSearch: next };
      }),
    );
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || activeTabId === null) return;
      if (e.key === "f") {
        e.preventDefault();
        toggleSearch(activeTabId);
      } else if (e.key === "g") {
        e.preventDefault();
        const tab = tabs.find((t) => t.meta.tab_id === activeTabId);
        if (!tab?.showSearch) return;
        const handle = toolbarRefs.current.get(activeTabId);
        if (e.shiftKey) handle?.findPrev();
        else handle?.findNext();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, tabs]);

  function updateSettings(patch: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }

  async function checkAndPromptUpdate(silent: boolean) {
    let update: Update | null;
    try {
      update = await checkForUpdate();
    } catch (e) {
      if (!silent) setOpenError(`Check for update failed: ${e}`);
      return;
    }
    if (!update) {
      if (!silent) window.alert("Gigagrid is already up to date.");
      return;
    }
    const notes = update.body ? `\n\n${update.body}` : "";
    const ok = window.confirm(
      `A new update is available: v${update.version}${notes}\n\nDownload and install now? The app will restart.`,
    );
    if (!ok) return;
    setUpdateBusy(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setUpdateBusy(false);
      setOpenError(`Update failed: ${e}`);
    }
  }

  // Silent on startup — a missing network / GitHub being briefly unreachable
  // shouldn't nag the user every launch; the toolbar button covers the
  // explicit "check now" case and surfaces its own errors.
  useEffect(() => {
    checkAndPromptUpdate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cycleTheme() {
    const order: Theme[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(settings.theme) + 1) % order.length];
    updateSettings({ theme: next });
  }

  function updateTab(tabId: number, patch: Partial<Tab>) {
    setTabs((prev) => prev.map((t) => (t.meta.tab_id === tabId ? { ...t, ...patch } : t)));
  }

  async function openFileAsNewTab(path: string, delimiter?: string) {
    try {
      const meta = await invoke<FileMeta>("open_file", { path, delimiter: delimiter ?? null });
      setOpenError(null);
      updateSettings({ recentFiles: pushRecentFile(settings.recentFiles, path) });
      setTabs((prev) => [
        ...prev,
        { meta, error: null, saving: false, savedAt: null, stats: EMPTY_STATS, showSearch: false, dirty: false, filterActive: false, sortActive: false },
      ]);
      setActiveTabId(meta.tab_id);
    } catch (e) {
      setOpenError(String(e));
    }
  }

  async function reopenWithDelimiter(tabId: number, delimiter: string) {
    const tab = tabs.find((t) => t.meta.tab_id === tabId);
    if (!tab) return;
    if (tab.dirty) {
      const ok = window.confirm(`"${tab.meta.path}" has unsaved changes. Reopen with a different delimiter and discard them?`);
      if (!ok) return;
    }
    const path = tab.meta.path;
    await invoke("close_tab", { tabId });
    gridRefs.current.delete(tabId);
    toolbarRefs.current.delete(tabId);
    setTabs((prev) => prev.filter((t) => t.meta.tab_id !== tabId));
    await openFileAsNewTab(path, delimiter);
  }

  async function openFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    await openFileAsNewTab(selected);
  }

  async function closeTab(tabId: number) {
    const tab = tabs.find((t) => t.meta.tab_id === tabId);
    if (tab?.dirty) {
      const ok = window.confirm(`"${tab.meta.path}" has unsaved changes. Close tab and discard them?`);
      if (!ok) return;
    }
    await invoke("close_tab", { tabId });
    gridRefs.current.delete(tabId);
    toolbarRefs.current.delete(tabId);
    const remaining = tabs.filter((t) => t.meta.tab_id !== tabId);
    setTabs(remaining);
    if (activeTabId === tabId) {
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].meta.tab_id : null);
    }
  }

  async function saveFile(tabId: number) {
    updateTab(tabId, { saving: true });
    try {
      await invoke("save_file", { tabId, dst: null });
      updateTab(tabId, { saving: false, savedAt: new Date(), error: null, dirty: false });
    } catch (e) {
      updateTab(tabId, { saving: false, error: String(e) });
    }
  }

  function handleNavigateFor(tabId: number, row: number, col?: number) {
    const handle = gridRefs.current.get(tabId);
    if (col !== undefined) handle?.selectCell(row, col);
    else handle?.scrollToRow(row);
  }

  // Replace happens entirely through the backend overlay (Toolbar never
  // touches Grid's own cache) — the grid's cached rows would otherwise
  // keep showing the pre-replace values until they scroll out of and back
  // into view, same reasoning as undo/redo invalidating the cache.
  function handleReplacedFor(tabId: number) {
    gridRefs.current.get(tabId)?.invalidateCache();
    updateTab(tabId, { dirty: true });
  }

  const ThemeIcon = settings.theme === "system" ? IconMonitor : settings.theme === "light" ? IconSun : IconMoon;

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", gap: 4, overflowX: "auto", flex: 1, minWidth: 0 }}>
          {tabs.map((tab) => (
            <div
              key={tab.meta.tab_id}
              onClick={() => setActiveTabId(tab.meta.tab_id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 8px",
                cursor: "pointer",
                borderBottom: tab.meta.tab_id === activeTabId ? "2px solid var(--fg)" : "2px solid transparent",
                opacity: tab.meta.tab_id === activeTabId ? 1 : 0.6,
                maxWidth: 200,
                flexShrink: 0,
              }}
              title={tab.meta.path}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {tab.meta.path.split(/[\\/]/).pop()}
                {tab.dirty ? " •" : ""}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.meta.tab_id);
                }}
                style={{ lineHeight: 1 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {activeTab?.savedAt && (
          <span style={{ opacity: 0.6, fontSize: 12, flexShrink: 0 }}>
            Saved {activeTab.savedAt.toLocaleTimeString()}
          </span>
        )}
        {tabs.map((tab) => (
          <div
            key={tab.meta.tab_id}
            style={{
              display: tab.meta.tab_id === activeTabId ? "flex" : "none",
              gap: 4,
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <Toolbar
              ref={(handle) => {
                if (handle) toolbarRefs.current.set(tab.meta.tab_id, handle);
                else toolbarRefs.current.delete(tab.meta.tab_id);
              }}
              tabId={tab.meta.tab_id}
              visible={tab.showSearch}
              onNavigate={(row, col) => handleNavigateFor(tab.meta.tab_id, row, col)}
              onToggleSearch={() => toggleSearch(tab.meta.tab_id)}
              onReplaced={() => handleReplacedFor(tab.meta.tab_id)}
              viewActive={tab.filterActive || tab.sortActive}
              onFilterChange={(active, rowCount) => {
                updateTab(tab.meta.tab_id, { filterActive: active, meta: { ...tab.meta, row_count: rowCount } });
                gridRefs.current.get(tab.meta.tab_id)?.invalidateCache();
              }}
            />
          </div>
        ))}
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <div style={{ position: "relative" }}>
            <button className="icon-btn" title="Open file" onClick={openFile} disabled={tabs.length >= MAX_TABS}>
              <IconFolder />
            </button>
            <button
              className="icon-btn"
              title="Recent files"
              onClick={() => setShowRecent((v) => !v)}
              disabled={settings.recentFiles.length === 0}
            >
              <IconClock />
            </button>
            {showRecent && settings.recentFiles.length > 0 && (
              <div
                style={{
                  position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 10,
                  display: "flex", flexDirection: "column", minWidth: 220,
                  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.2)", padding: 4,
                }}
              >
                {settings.recentFiles.map((p) => (
                  <button
                    key={p}
                    onClick={() => { setShowRecent(false); openFileAsNewTab(p); }}
                    style={{ textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={p}
                  >
                    {p.split(/[\\/]/).pop()}
                  </button>
                ))}
              </div>
            )}
          </div>
          {activeTab && (
            <button
              className="icon-btn"
              title={activeTab.saving ? "Saving…" : "Save"}
              onClick={() => saveFile(activeTab.meta.tab_id)}
              disabled={activeTab.saving}
            >
              <IconSave />
            </button>
          )}
          <button className="icon-btn" title={`Theme: ${settings.theme} (click to change)`} onClick={cycleTheme}>
            <ThemeIcon />
          </button>
          <button
            className="icon-btn"
            data-active={settings.showGridChrome}
            title="Toggle grid lines"
            onClick={() => updateSettings({ showGridChrome: !settings.showGridChrome })}
          >
            <IconGrid />
          </button>
          <button
            className="icon-btn"
            data-active={settings.freezeHeader}
            title="Toggle freeze header"
            onClick={() => updateSettings({ freezeHeader: !settings.freezeHeader })}
          >
            <IconPin />
          </button>
          <button
            className="icon-btn"
            title={updateBusy ? "Updating…" : "Check for updates"}
            onClick={() => checkAndPromptUpdate(false)}
            disabled={updateBusy}
          >
            <IconDownload />
          </button>
        </div>
      </div>
      {tabs.map((tab) => {
        const isActive = tab.meta.tab_id === activeTabId;
        return (
          <div
            key={tab.meta.tab_id}
            style={{ display: isActive ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}
          >
            <div style={{ flex: 1, minHeight: 0 }}>
              <Grid
                ref={(handle) => {
                  if (handle) gridRefs.current.set(tab.meta.tab_id, handle);
                  else gridRefs.current.delete(tab.meta.tab_id);
                }}
                tabId={tab.meta.tab_id}
                rowCount={tab.meta.row_count}
                showGridChrome={settings.showGridChrome}
                freezeHeader={settings.freezeHeader}
                onStatsChange={(stats) => {
                  updateTab(tab.meta.tab_id, { stats, error: null });
                  setOpenError(null);
                }}
                onDirtyChange={(dirty) => updateTab(tab.meta.tab_id, { dirty })}
                onError={(message) => updateTab(tab.meta.tab_id, { error: message })}
                onRowCountChange={(row_count) => updateTab(tab.meta.tab_id, { meta: { ...tab.meta, row_count } })}
                viewActive={tab.filterActive || tab.sortActive}
                onSortChange={(active, rowCount) => updateTab(tab.meta.tab_id, { sortActive: active, meta: { ...tab.meta, row_count: rowCount } })}
              />
            </div>
            <StatusBar
              file={tab.meta}
              stats={tab.stats}
              error={isActive ? (tab.error ?? openError) : tab.error}
              onReopenWithDelimiter={(d) => reopenWithDelimiter(tab.meta.tab_id, d)}
            />
          </div>
        );
      })}
      {tabs.length === 0 && openError && (
        <div
          style={{
            padding: "2px 8px",
            borderTop: "1px solid var(--border)",
            fontSize: 12,
            color: "red",
            flexShrink: 0,
          }}
        >
          {openError}
        </div>
      )}
    </main>
  );
}

export default App;
