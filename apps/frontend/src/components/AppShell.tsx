import { useEffect, useRef } from 'react';
import type { ReactNode, TouchEvent } from 'react';
import historyIcon from '../assets/history.svg';
import type { PageId } from '../types';

interface AppShellProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  onOpenConversations?: () => void;
  onOpenFavorites?: () => void;
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

export function AppShell({ currentPage, onNavigate, onOpenConversations, onOpenFavorites, children }: AppShellProps) {
  const navRef = useRef<HTMLElement>(null);
  const mainPanelRef = useRef<HTMLElement>(null);
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

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

  return (
    <div className="app-shell">
      <button
        type="button"
        className="settings-trigger favorite-entry-trigger"
        onClick={() => {
          onNavigate('home');
          onOpenFavorites?.();
        }}
        aria-label="打开菜谱收藏"
      >
        <img className="settings-trigger-icon" src={historyIcon} alt="" aria-hidden="true" />
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
          <h2 className="eyebrow">Cookbook Assistant</h2>
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
    </div>
  );
}
