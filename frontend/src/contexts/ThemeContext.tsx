import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * 表示テーマ（ライト／ダーク）。
 * - 初期値：localStorage に保存された選択があればそれ、無ければ OS の設定（prefers-color-scheme）。
 * - 利用者が切り替えたら localStorage に保存し、次回も維持する。保存が無い間は OS の設定変更に追従する。
 * - 反映は <html> の class="dark" の有無（Tailwind の darkMode: 'class'）。
 *   初回描画のちらつきを防ぐため、index.html の先頭スクリプトでも同じ規則で先に class を付けている。
 */
export type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'cloud-dojo-theme';

function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme() ?? systemTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 利用者が明示的に選んでいない間は OS の設定変更に追従する
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      if (readStoredTheme() === null) setThemeState(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 別タブでの切替を反映する
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return;
      setThemeState(e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : systemTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 保存できない環境でも表示の切替だけは行う
    }
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
