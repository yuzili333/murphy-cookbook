import type { ReactNode } from 'react';
import { SvgIcon } from './SvgIcon';
import chatHistorySvg from '../assets/chat-history.svg?raw';
import favoriteSvg from '../assets/favorite.svg?raw';

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
          <SvgIcon svg={chatHistorySvg} />
        </button>
        <div className="brand-block">
          <span className="shell-mascot" aria-hidden="true">
            <img src={murphyAvatarImage} alt="" aria-hidden="true" />
          </span>
          <div>
            <h1>{isChinese ? '菜谱助手' : "AI Cookbook"}</h1>
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
            <SvgIcon className="favorite-entry-icon" svg={favoriteSvg} />
          </button>
        </div>
      </aside>
      <main className="main-panel">
        {children}
      </main>
    </div>
  );
}
