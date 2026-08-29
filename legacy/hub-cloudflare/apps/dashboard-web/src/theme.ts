export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'shikoonet-theme';

export function getStoredThemeMode(): ThemeMode {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): 'light' | 'dark' {
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', resolved);
  return resolved;
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
  applyTheme(mode);
}
