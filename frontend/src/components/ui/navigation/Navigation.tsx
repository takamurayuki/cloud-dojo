import { useState, useRef, useEffect, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  Wifi,
  Container,
  Layers,
  Network,
  GitBranch,
  GraduationCap,
  FlaskConical,
  Pin,
  PinOff,
  Sun,
  Moon,
} from 'lucide-react';
import { ROUTES } from '@/config/constants';
import { useTheme } from '@/contexts/ThemeContext';
import logoUrl from '@/assets/cloud-dojo-logo.png';

const navItems = [
  {
    to: ROUTES.HOME,
    icon: LayoutDashboard,
    label: 'Dashboard',
    color: 'from-blue-500 to-cyan-500',
  },
  {
    to: ROUTES.NETWORK,
    icon: Wifi,
    label: 'Network Basics',
    color: 'from-cyan-500 to-blue-500',
  },
  { to: ROUTES.DOCKER, icon: Container, label: 'Docker Build', color: 'from-blue-600 to-blue-400' },
  {
    to: ROUTES.COMPOSE,
    icon: Layers,
    label: 'Docker Compose',
    color: 'from-purple-600 to-pink-500',
  },
  {
    to: ROUTES.KUBERNETES,
    icon: Network,
    label: 'Kubernetes',
    color: 'from-indigo-500 to-purple-500',
  },
  {
    to: ROUTES.CICD,
    icon: GitBranch,
    label: 'CI/CD Pipeline',
    color: 'from-orange-500 to-red-500',
  },
  {
    to: ROUTES.LEARNING,
    icon: GraduationCap,
    label: 'Learning Path',
    color: 'from-green-500 to-emerald-500',
  },
  {
    to: ROUTES.UNIT_N5,
    icon: FlaskConical,
    label: 'N5 TCP接続',
    color: 'from-emerald-500 to-teal-500',
  },
];

const NAV_PIN_KEY = 'nav-pinned';

const getPinnedState = () => {
  const stored = localStorage.getItem(NAV_PIN_KEY);
  return stored === 'true';
};

const setPinnedState = (pinned: boolean) => {
  localStorage.setItem(NAV_PIN_KEY, pinned.toString());
};

export function Navigation() {
  const [isPinned, setIsPinned] = useState(getPinnedState());
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);

  const isExpanded = isPinned || isHovered;
  const { theme, toggleTheme } = useTheme();
  const nextThemeLabel = theme === 'dark' ? 'ライト表示に切り替え' : 'ダーク表示に切り替え';

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === NAV_PIN_KEY) {
        setIsPinned(e.newValue === 'true');
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // ピン状態変更時に LocalStorage 保存
  useEffect(() => {
    setPinnedState(isPinned);
  }, [isPinned]);

  const handleMouseEnter = useCallback(() => {
    if (isPinned) return; // ピン固定中はホバー処理不要
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setIsHovered(true);
    }, 200);
  }, [isPinned]);

  const handleMouseLeave = useCallback(() => {
    if (isPinned) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 150);
  }, [isPinned]);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const togglePin = () => {
    setIsPinned((prev) => !prev);
  };

  return (
    <motion.nav
      className="w-64 shrink-0 border-r border-border bg-card relative overflow-hidden"
      animate={{ width: isExpanded ? 256 : 64 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      aria-expanded={isExpanded}
    >
      {/* Background gradient */}
      <div className="absolute inset-0 gradient-mesh opacity-40" />

      <div className="relative z-10 flex flex-col h-full">
        <div className="p-3 pt-4 border-b border-border space-y-3">
          {/* ロゴ：画像は src/assets から読み込む（以前は配信されない /icons/ を参照していて代替テキストが重なっていた） */}
          <div className={`flex items-center h-10 ${isExpanded ? 'gap-2' : 'justify-center'}`}>
            <NavLink
              to={ROUTES.HOME}
              className="flex items-center gap-2 min-w-0 rounded-lg"
              aria-label="Cloud Dojo ホーム"
            >
              <img src={logoUrl} alt="" width={36} height={36} className="w-9 h-9 shrink-0 object-contain" />
              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="text-lg font-bold tracking-tight text-foreground whitespace-nowrap"
                  >
                    Cloud Dojo
                  </motion.span>
                )}
              </AnimatePresence>
            </NavLink>
            {/* ピンボタン */}
            <AnimatePresence>
              {isExpanded && (
                <motion.button
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.15 }}
                  onClick={togglePin}
                  className={`ml-auto p-1.5 rounded-md transition-colors hover:bg-muted ${isPinned ? 'text-primary' : 'text-muted-foreground'}`}
                  aria-label={isPinned ? 'ナビゲーション固定を解除' : 'ナビゲーションを固定'}
                  aria-pressed={isPinned}
                  title={isPinned ? '固定解除' : '固定'}
                >
                  {isPinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          {/* テーマ切替：アイコンと「いまの表示」を出す。折りたたみ時はアイコンのみ（ツールチップに説明） */}
          <button
            type="button"
            onClick={toggleTheme}
            data-testid="theme-toggle"
            aria-label={`表示テーマ：${theme === 'dark' ? 'ダーク' : 'ライト'}（${nextThemeLabel}）`}
            title={nextThemeLabel}
            className={`w-full flex items-center h-9 rounded-lg border border-border bg-background/60 text-sm text-foreground hover:bg-muted transition-colors ${
              isExpanded ? 'gap-2 px-3' : 'justify-center'
            }`}
          >
            {theme === 'dark' ? <Moon className="w-4 h-4 shrink-0" /> : <Sun className="w-4 h-4 shrink-0 text-amber-600" />}
            {isExpanded && (
              <span className="whitespace-nowrap">
                {theme === 'dark' ? 'ダーク' : 'ライト'}
                <span className="text-muted-foreground">（切替）</span>
              </span>
            )}
          </button>
        </div>

        <div className="space-y-1.5 p-3 mt-1">
          {navItems.map((item, index) => (
            <motion.div
              key={item.to}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: index * 0.1 }}
            >
              <NavLink
                to={item.to}
                end={item.to === ROUTES.HOME}
                title={isExpanded ? undefined : item.label}
                className={({ isActive }) =>
                  `group flex items-center ${isExpanded ? 'gap-3 px-3' : 'justify-center px-2'} py-2.5 rounded-xl transition-colors duration-200 relative overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isActive
                      ? 'bg-gradient-to-r ' + item.color + ' text-white shadow-md font-semibold'
                      : 'text-foreground/85 hover:bg-muted hover:text-foreground'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {/* 現在地：左端のバー（折りたたみ時も見える） */}
                    {isActive && (
                      <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-white/90" />
                    )}
                    <item.icon
                      className={`w-5 h-5 shrink-0 relative z-10 transition-transform group-hover:scale-110 ${
                        isActive ? '' : 'text-muted-foreground group-hover:text-foreground'
                      }`}
                    />
                    <AnimatePresence mode="wait">
                      {isExpanded && (
                        <motion.span
                          initial={{ opacity: 0, width: 0 }}
                          animate={{ opacity: 1, width: 'auto' }}
                          exit={{ opacity: 0, width: 0 }}
                          transition={{ duration: 0.15 }}
                          className="relative z-10 text-sm whitespace-nowrap overflow-hidden text-ellipsis"
                        >
                          {item.label}
                        </motion.span>
                      )}
                    </AnimatePresence>
                    {isActive && isExpanded && (
                      <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] font-semibold tracking-wide bg-white/25 rounded px-1.5 py-0.5 relative z-10">
                        現在地
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.nav>
  );
}
