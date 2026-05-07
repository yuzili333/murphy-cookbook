import type { ReactNode } from 'react';
import historyIcon from '../assets/history.svg';

interface AppShellProps {
  onOpenConversations?: () => void;
  onOpenFavorites?: () => void;
  children: ReactNode;
}

export function AppShell({ onOpenConversations, onOpenFavorites, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <button
        type="button"
        className="settings-trigger favorite-entry-trigger"
        onClick={onOpenFavorites}
        aria-label="打开菜谱收藏"
      >
        <img className="settings-trigger-icon" src={historyIcon} alt="" aria-hidden="true" />
      </button>
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
          <h2 className="eyebrow">Cookbook Assistant</h2>
        </div>
      </aside>
      <main className="main-panel">
        {children}
      </main>
    </div>
  );
}
