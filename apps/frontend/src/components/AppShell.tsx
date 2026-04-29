import { useEffect, useRef, useState } from 'react';
import type { ReactNode, TouchEvent } from 'react';
import type { PageId } from '../types';

interface AppShellProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  onOpenConversations?: () => void;
  children: ReactNode;
}

const pageOrder: PageId[] = [
  'home',
  'input',
  'confirm',
  'recipes',
  'detail',
  'cooking',
  'feedback',
  'logs',
];

const settingsPages: PageId[] = ['favorites'];

const pageLabels: Record<PageId, string> = {
  home: '首页',
  favorites: '菜谱收藏',
  profile: '儿童档案',
  input: '食材输入',
  confirm: '识别确认',
  recipes: '菜谱推荐',
  detail: '菜谱详情',
  cooking: '分步烹饪',
  feedback: '成果点评',
  logs: '调试日志',
};

export function AppShell({ currentPage, onNavigate, onOpenConversations, children }: AppShellProps) {
  const navRef = useRef<HTMLElement>(null);
  const mainPanelRef = useRef<HTMLElement>(null);
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  useEffect(() => {
    const activeItem = navRef.current?.querySelector<HTMLElement>('.nav-item.active');
    activeItem?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: 'smooth',
    });

    mainPanelRef.current?.scrollIntoView({
      block: 'start',
      behavior: 'smooth',
    });
  }, [currentPage]);

  const handleTouchStart = (event: TouchEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, button')) {
      touchStartXRef.current = null;
      touchStartYRef.current = null;
      return;
    }

    touchStartXRef.current = event.changedTouches[0]?.clientX ?? null;
    touchStartYRef.current = event.changedTouches[0]?.clientY ?? null;
  };

  const handleTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const startX = touchStartXRef.current;
    const startY = touchStartYRef.current;
    touchStartXRef.current = null;
    touchStartYRef.current = null;

    if (startX === null || startY === null) {
      return;
    }

    const endX = event.changedTouches[0]?.clientX ?? startX;
    const endY = event.changedTouches[0]?.clientY ?? startY;
    const deltaX = endX - startX;
    const deltaY = endY - startY;

    if (Math.abs(deltaX) < 72 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) {
      return;
    }

    const currentIndex = pageOrder.indexOf(currentPage);
    if (currentIndex === -1) {
      return;
    }

    if (deltaX < 0 && currentIndex < pageOrder.length - 1) {
      onNavigate(pageOrder[currentIndex + 1]);
      return;
    }

    if (deltaX > 0 && currentIndex > 0) {
      onNavigate(pageOrder[currentIndex - 1]);
    }
  };

  const handleSettingsNavigate = (page: PageId) => {
    onNavigate(page);
    setIsSettingsOpen(false);
  };

  return (
    <div className="app-shell">
      <button
        type="button"
        className="settings-trigger"
        onClick={() => setIsSettingsOpen(true)}
        aria-label="打开用户设置"
      >
        <svg
          className="settings-trigger-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Zm0 5.6a1.85 1.85 0 1 1 0-3.7 1.85 1.85 0 0 1 0 3.7Z" />
          <path d="M20.32 10.6 18.9 10.2a7.14 7.14 0 0 0-.55-1.33l.72-1.29a1.15 1.15 0 0 0-.18-1.34l-1.13-1.13a1.15 1.15 0 0 0-1.34-.18l-1.29.72c-.43-.23-.87-.42-1.33-.55l-.4-1.42A1.16 1.16 0 0 0 12.28 3h-1.6c-.53 0-.99.36-1.12.87l-.4 1.42c-.46.13-.9.32-1.33.55l-1.29-.72a1.15 1.15 0 0 0-1.34.18L4.07 6.43a1.15 1.15 0 0 0-.18 1.34l.72 1.29c-.23.43-.42.87-.55 1.33l-1.42.4A1.16 1.16 0 0 0 1.77 11.9v1.6c0 .53.36.99.87 1.12l1.42.4c.13.46.32.9.55 1.33l-.72 1.29c-.25.45-.18 1.02.18 1.34l1.13 1.13c.36.36.89.43 1.34.18l1.29-.72c.43.23.87.42 1.33.55l.4 1.42c.13.51.59.87 1.12.87h1.6c.53 0 .99-.36 1.12-.87l.4-1.42c.46-.13.9-.32 1.33-.55l1.29.72c.45.25.98.18 1.34-.18l1.13-1.13c.36-.32.43-.89.18-1.34l-.72-1.29c.23-.43.42-.87.55-1.33l1.42-.4c.51-.13.87-.59.87-1.12v-1.6c0-.53-.36-.99-.87-1.12Zm-1.03 2.32-1.24.35a.95.95 0 0 0-.66.67 5.56 5.56 0 0 1-.74 1.79.95.95 0 0 0-.02.94l.63 1.13-.65.65-1.13-.63a.95.95 0 0 0-.94.02 5.56 5.56 0 0 1-1.79.74.95.95 0 0 0-.67.66l-.35 1.24h-.92l-.35-1.24a.95.95 0 0 0-.67-.66 5.56 5.56 0 0 1-1.79-.74.95.95 0 0 0-.94-.02l-1.13.63-.65-.65.63-1.13a.95.95 0 0 0-.02-.94 5.56 5.56 0 0 1-.74-1.79.95.95 0 0 0-.66-.67l-1.24-.35V12l1.24-.35a.95.95 0 0 0 .66-.67c.17-.63.42-1.23.74-1.79a.95.95 0 0 0 .02-.94l-.63-1.13.65-.65 1.13.63c.3.17.66.16.94-.02.56-.32 1.16-.57 1.79-.74.32-.08.58-.34.67-.66l.35-1.24h.92l.35 1.24c.09.32.35.58.67.66.63.17 1.23.42 1.79.74.28.18.64.19.94.02l1.13-.63.65.65-.63 1.13a.95.95 0 0 0 .02.94c.32.56.57 1.16.74 1.79.08.32.34.58.66.67l1.24.35v.92Z" />
        </svg>
      </button>
      <aside className="sidebar">
        <button
          type="button"
          className="chat-menu-button"
          onClick={() => {
            onNavigate('home');
            onOpenConversations?.();
          }}
          aria-label="打开历史对话"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4.8 6.8h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 0 0 0 1.8Zm0 6.1h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 1 0 0 1.8Zm0 6.1h14.4a.9.9 0 1 0 0-1.8H4.8a.9.9 0 1 0 0 1.8Z" />
          </svg>
        </button>
        <div className="brand-block">
          <h2 className="eyebrow">Murphy's Cookbook</h2>
        </div>
        <nav ref={navRef} className="progress-nav" aria-label="MVP page flow">
          {pageOrder.map((page, index) => (
            <button
              key={page}
              className={page === currentPage ? 'nav-item active' : 'nav-item'}
              onClick={() => onNavigate(page)}
              type="button"
            >
              <span className="nav-index">{String(index + 1).padStart(2, '0')}</span>
              <strong>{pageLabels[page]}</strong>
            </button>
          ))}
        </nav>
      </aside>
      <main ref={mainPanelRef} className="main-panel" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        {children}
      </main>

      {isSettingsOpen ? (
        <div className="settings-layer" role="presentation">
          <button
            type="button"
            className="settings-backdrop"
            aria-label="关闭用户设置"
            onClick={() => setIsSettingsOpen(false)}
          />
          <aside className="settings-drawer" aria-label="用户设置">
            <div className="drawer-header">
              <div>
                <p className="eyebrow">用户设置</p>
                <h2>用户设置</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => setIsSettingsOpen(false)}>
                关闭
              </button>
            </div>
            <div className="settings-menu">
              {settingsPages.map((page) => (
                <button
                  key={page}
                  type="button"
                  className={page === currentPage ? 'settings-menu-item active' : 'settings-menu-item'}
                  onClick={() => handleSettingsNavigate(page)}
                >
                  <strong>{pageLabels[page]}</strong>
                  <span>查看和管理已收藏菜谱</span>
                </button>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
