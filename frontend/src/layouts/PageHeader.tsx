import { motion } from 'framer-motion';
import type { ElementType, ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  Icon?: ElementType;
  /** アイコン枠の背景（グラデーション等）。見出しの文字色は両テーマで読めるよう前景色に統一する */
  bgColor?: string;
  /** 見出しの上に出す小さな区分（例：ドメイン / 単元コード） */
  eyebrow?: ReactNode;
  /** 見出しの右側に置く要素（状態表示など） */
  aside?: ReactNode;
}

/** 全ページ共通の見出し。見出し・説明・余白の階層をここで揃える */
export function PageHeader({ title, description, Icon, bgColor, eyebrow, aside }: PageHeaderProps) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-wrap items-start justify-between gap-4"
    >
      <div className="flex items-center gap-4 min-w-0">
        {Icon && (
          <div className={`w-12 h-12 shrink-0 ${bgColor ?? 'bg-primary'} rounded-2xl flex items-center justify-center shadow-sm`}>
            <Icon className="w-6 h-6 text-white" />
          </div>
        )}
        <div className="min-w-0 space-y-1">
          {eyebrow && <div className="text-sm font-medium text-muted-foreground">{eyebrow}</div>}
          <h1 className="page-title">{title}</h1>
          {description && <p className="page-subtitle max-w-3xl">{description}</p>}
        </div>
      </div>
      {aside}
    </motion.header>
  );
}
