import "./App.css";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Grid, type GridHandle } from "./components/Grid";
import { Toolbar } from "./components/Toolbar";
import { SearchPanel, type SearchPanelHandle } from "./components/SearchPanel";
import { StatusBar, type GridStats } from "./components/StatusBar";
import { loadSettings, saveSettings, pushRecentFile, type Settings, type Theme } from "./settings";
import { IconFolder, IconSave, IconMonitor, IconSun, IconMoon, IconGrid, IconPin, IconDownload, IconClock } from "./icons";
import { findExistingTab, getAdjacentTabIndex, getTabIndexFromKey } from "./tabNav";

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
  const [showSearch, setShowSearch] = useState(false);
  const gridRefs = useRef<Map<number, GridHandle>>(new Map());
  const searchPanelRef = useRef<SearchPanelHandle>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;

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

  function toggleSearch() {
    setShowSearch((prev) => {
      const next = !prev;
      if (next) window.setTimeout(() => searchPanelRef.current?.focusAndSelect(), 0);
      return next;
    });
  }

  useEffect(() => {
    function isEditingText(): boolean {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (activeTabId === null) return;

      // 1. Tab shortcuts: Cmd+1..9
      if (mod && !e.altKey && !e.shiftKey) {
        const targetIndex = getTabIndexFromKey(e.key, tabs.length);
        if (targetIndex !== null) {
          e.preventDefault();
          setActiveTabId(tabs[targetIndex].meta.tab_id);
          return;
        }
      }

      // 2. Tab switching: Cmd+Option+Left/Right (always) OR Cmd+Shift+Left/Right (only when not editing text)
      const isArrowTab =
        (mod && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) ||
        (mod && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !isEditingText());

      if (isArrowTab) {
        e.preventDefault();
        if (tabs.length > 1) {
          const currentIndex = tabs.findIndex((t) => t.meta.tab_id === activeTabId);
          if (currentIndex !== -1) {
            const nextIndex = getAdjacentTabIndex(
              currentIndex,
              tabs.length,
              e.key === "ArrowLeft" ? "left" : "right",
            );
            setActiveTabId(tabs[nextIndex].meta.tab_id);
            return;
          }
        }
      }

      // 3. Search shortcuts:
      // Cmd+F: Toggle search panel; when opening -> select all
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleSearch();
        return;
      }

      // Cmd+G and Cmd+Shift+G:
      // If search not open -> open it and jump next/prev
      // If search open -> jump next/prev
      if (mod && !e.altKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (!showSearch) {
          setShowSearch(true);
        }
        window.setTimeout(() => {
          if (e.shiftKey) {
            searchPanelRef.current?.findPrev();
          } else {
            searchPanelRef.current?.findNext();
          }
        }, 0);
        return;
      }

      // Escape: close search panel if open
      if (e.key === "Escape" && showSearch) {
        e.preventDefault();
        setShowSearch(false);
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, tabs, showSearch]);

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
      if (!silent) {
        await message("Gigagrid is already up to date.", {
          title: "Gigagrid",
          kind: "info",
        });
      }
      return;
    }
    const notes = update.body ? `\n\n${update.body}` : "";
    const ok = await ask(
      `A new update is available: v${update.version}${notes}\n\nDownload and install now? The app will restart.`,
      {
        title: "Update Available",
        kind: "info",
        okLabel: "Update",
        cancelLabel: "Later",
      },
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
    if (!delimiter) {
      const existing = findExistingTab(tabsRef.current, path);
      if (existing) {
        setActiveTabId(existing.meta.tab_id);
        return;
      }
    }
    try {
      const meta = await invoke<FileMeta>("open_file", { path, delimiter: delimiter ?? null });
      setOpenError(null);
      updateSettings({ recentFiles: pushRecentFile(settings.recentFiles, path) });
      const newTab: Tab = {
        meta,
        error: null,
        saving: false,
        savedAt: null,
        stats: EMPTY_STATS,
        dirty: false,
        filterActive: false,
        sortActive: false,
      };
      tabsRef.current = [...tabsRef.current, newTab];
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(meta.tab_id);
    } catch (e) {
      setOpenError(String(e));
    }
  }

  async function reopenWithDelimiter(tabId: number, delimiter: string) {
    const tab = tabs.find((t) => t.meta.tab_id === tabId);
    if (!tab) return;
    if (tab.dirty) {
      const ok = await ask(
        `"${tab.meta.path}" has unsaved changes. Reopen with a different delimiter and discard them?`,
        {
          title: "Unsaved Changes",
          kind: "warning",
          okLabel: "Discard",
          cancelLabel: "Cancel",
        },
      );
      if (!ok) return;
    }
    const path = tab.meta.path;
    await invoke("close_tab", { tabId });
    gridRefs.current.delete(tabId);
    tabsRef.current = tabsRef.current.filter((t) => t.meta.tab_id !== tabId);
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
      const ok = await ask(
        `"${tab.meta.path}" has unsaved changes. Close tab and discard them?`,
        {
          title: "Unsaved Changes",
          kind: "warning",
          okLabel: "Discard",
          cancelLabel: "Cancel",
        },
      );
      if (!ok) return;
    }
    await invoke("close_tab", { tabId });
    gridRefs.current.delete(tabId);
    tabsRef.current = tabsRef.current.filter((t) => t.meta.tab_id !== tabId);
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
        <div className="tab-bar-container">
          {tabs.map((tab) => {
            const isActive = tab.meta.tab_id === activeTabId;
            const fileName = tab.meta.path.split(/[\\/]/).pop();
            return (
              <div
                key={tab.meta.tab_id}
                data-active={isActive}
                className="tab-item"
                onClick={() => setActiveTabId(tab.meta.tab_id)}
                title={tab.meta.path}
              >
                <span className="tab-title">
                  {fileName}
                  {tab.dirty ? " •" : ""}
                </span>
                <button
                  className="tab-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.meta.tab_id);
                  }}
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {activeTab?.savedAt && (
          <span style={{ opacity: 0.6, fontSize: 12, flexShrink: 0 }}>
            Saved {activeTab.savedAt.toLocaleTimeString()}
          </span>
        )}
        {activeTab && (
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
            <Toolbar
              tabId={activeTab.meta.tab_id}
              visible={showSearch}
              onNavigate={(row, col) => handleNavigateFor(activeTab.meta.tab_id, row, col)}
              onToggleSearch={toggleSearch}
              viewActive={activeTab.filterActive || activeTab.sortActive}
              onFilterChange={(active, rowCount) => {
                updateTab(activeTab.meta.tab_id, {
                  filterActive: active,
                  meta: { ...activeTab.meta, row_count: rowCount },
                });
                gridRefs.current.get(activeTab.meta.tab_id)?.invalidateCache();
              }}
            />
          </div>
        )}
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
          <button className="icon-btn" title={`Theme: ${settings.theme} (click to change)`} onClick={cycleTheme}>
            <ThemeIcon />
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
      <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
                  freezeCols={settings.freezeCols}
                  onFreezeColsChange={(freezeCols) => updateSettings({ freezeCols })}
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
        {activeTab && (
          <SearchPanel
            ref={searchPanelRef}
            tabId={activeTab.meta.tab_id}
            visible={showSearch}
            onClose={() => setShowSearch(false)}
            onNavigate={(row, col) => handleNavigateFor(activeTab.meta.tab_id, row, col)}
            onReplaced={() => handleReplacedFor(activeTab.meta.tab_id)}
            viewActive={activeTab.filterActive || activeTab.sortActive}
          />
        )}
      </div>
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
