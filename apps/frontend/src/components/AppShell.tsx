import type { ReactNode } from 'react';
import historyIcon from '../assets/history.svg';

interface AppShellProps {
  onOpenConversations?: () => void;
  onOpenFavorites?: () => void;
  locale?: 'zh' | 'en';
  onLocaleChange?: (locale: 'zh' | 'en') => void;
  children: ReactNode;
}

export function AppShell({ onOpenConversations, onOpenFavorites, locale = 'zh', onLocaleChange, children }: AppShellProps) {
  const isChinese = locale === 'zh';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          type="button"
          className="chat-menu-button"
          onClick={onOpenConversations}
          aria-label="打开历史对话"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4.8 6.8h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 0 0 0 1.8Zm0 6.1h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 1 0 0 1.8Zm0 6.1h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 1 0 0 1.8Z" />
          </svg>
        </button>
        <div className="brand-block">
          <span className="shell-mascot" aria-hidden="true">👩‍🍳</span>
          <div>
            <h1>{isChinese ? '小墨菲的美食宝典' : "Murphy's Cookbook"}</h1>
            <p>{isChinese ? '儿童 AI 菜谱伙伴' : 'AI Recipe Buddy for Kids'}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="favorite-entry-trigger"
            onClick={onOpenFavorites}
            aria-label={isChinese ? '打开菜谱收藏' : 'Open recipe collection'}
          >
            <img className="settings-trigger-icon" src={historyIcon} alt="" aria-hidden="true" />
          </button>
          <div className="locale-switch" role="group" aria-label={isChinese ? '切换语言' : 'Switch language'}>
            <button
              type="button"
              className={isChinese ? 'active' : undefined}
              onClick={() => onLocaleChange?.('zh')}
            >
              中文
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
        </div>
      </aside>
      <main className="main-panel">
        {children}
      </main>
    </div>
  );
}
