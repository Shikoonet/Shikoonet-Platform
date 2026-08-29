import { useEffect, useState } from 'react';
import {
  applyTheme,
  getStoredThemeMode,
  setThemeMode,
  type ThemeMode,
} from './theme.js';

const MODES: Array<{ value: ThemeMode; label: string; icon: string }> = [
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'dark', label: 'Dark', icon: '☾' },
  { value: 'system', label: 'System', icon: '◐' },
];

export function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>(() => getStoredThemeMode());

  useEffect(() => {
    applyTheme(mode);
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  function select(next: ThemeMode) {
    setMode(next);
    setThemeMode(next);
  }

  return { mode, select };
}

export function ThemeSwitcher({ variant = 'toolbar' }: { variant?: 'toolbar' | 'menu' }) {
  const { mode, select } = useThemeMode();

  if (variant === 'menu') {
    return (
      <div className="theme-switcher theme-switcher--menu" role="group" aria-label="Color theme">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="menuitemradio"
            aria-checked={mode === m.value}
            className={`theme-switcher__menu-item${mode === m.value ? ' theme-switcher__menu-item--active' : ''}`}
            onClick={() => select(m.value)}
          >
            <span aria-hidden>{m.icon}</span>
            {m.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="theme-switcher" role="group" aria-label="Color theme">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          className={`theme-switcher__btn${mode === m.value ? ' theme-switcher__btn--active' : ''}`}
          aria-pressed={mode === m.value}
          aria-label={m.label}
          title={m.label}
          onClick={() => select(m.value)}
        >
          <span aria-hidden>{m.icon}</span>
        </button>
      ))}
    </div>
  );
}
