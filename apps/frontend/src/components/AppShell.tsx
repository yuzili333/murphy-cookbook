import type { ReactNode } from 'react';
import favoriteIcon from '../assets/favorite.svg';

const murphyAvatarImage = new URL('../../../../design-image/murphy-avatar.png', import.meta.url).href;

interface AppShellProps {
  onOpenConversations?: () => void;
  onOpenFavorites?: () => void;
  locale?: 'zh' | 'en';
  onLocaleChange?: (locale: 'zh' | 'en') => void;
  children: ReactNode;
}

export function AppShell({
  onOpenConversations,
  onOpenFavorites,
  locale = 'zh',
  onLocaleChange,
  children,
}: AppShellProps) {
  const isChinese = locale === 'zh';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          type="button"
          className="chat-menu-button"
          onClick={onOpenConversations}
          aria-label={isChinese ? '打开历史对话' : 'Open chat history'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4.8 6.8h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 0 0 0 1.8Zm0 6.1h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 1 0 0 1.8Zm0 6.1h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 1 0 0 1.8Z" />
          </svg>
        </button>
        <div className="brand-block">
          <span className="shell-mascot" aria-hidden="true">
            <img src={murphyAvatarImage} alt="" aria-hidden="true" />
          </span>
          <div>
            <h1>{isChinese ? '食谱Agent' : "AI Cookbook"}</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="locale-switch" role="group" aria-label={isChinese ? '切换语言' : 'Switch language'}>
            <button
              type="button"
              className={isChinese ? 'active' : undefined}
              onClick={() => onLocaleChange?.('zh')}
            >
              {isChinese ? '中文' : 'CN'}
            </button>
            <span aria-hidden="true">|</span>
            <button
              type="button"
              className={!isChinese ? 'active' : undefined}
              onClick={() => onLocaleChange?.('en')}
            >
              EN
            </button>
          </div>
          <button
            type="button"
            className="favorite-entry-trigger"
            onClick={onOpenFavorites}
            aria-label={isChinese ? '打开菜谱收藏' : 'Open recipe collection'}
          >
            <img
              className="favorite-entry-icon"
              src={favoriteIcon}
              alt=""
              aria-hidden="true"
            />
          </button>
        </div>
      </aside>
      <main className="main-panel">
        {children}
      </main>
    </div>
  );
}
