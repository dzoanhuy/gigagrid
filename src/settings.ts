export type Theme = "system" | "light" | "dark";

export interface Settings {
  theme: Theme;
  showGridChrome: boolean;
  freezeHeader: boolean;
  recentFiles: string[];
  freezeCols: number;
}

const STORAGE_KEY = "gigagrid.settings";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  showGridChrome: true,
  freezeHeader: true,
  recentFiles: [],
  freezeCols: 0,
};

export const MAX_RECENT_FILES = 10;

export function pushRecentFile(list: string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, MAX_RECENT_FILES);
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (private mode, disabled) — settings just won't persist.
  }
}
