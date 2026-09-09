export type Theme = "system" | "light" | "dark";

export interface Settings {
  theme: Theme;
  showGridChrome: boolean;
  freezeHeader: boolean;
}

const STORAGE_KEY = "gigagrid.settings";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  showGridChrome: true,
  freezeHeader: true,
};

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
    // localStorage không dùng được (private mode, disabled) — setting chỉ không persist.
  }
}
