import { useRef } from 'react';
import type { ReactNode, TouchEvent } from 'react';
import type { PageId } from '../types';

interface AppShellProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  children: ReactNode;
}

const pageOrder: PageId[] = [
  'home',
  'favorites',
  'profile',
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

export function AppShell({ currentPage, onNavigate, children }: AppShellProps) {
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

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
      <aside className="sidebar">
        <div className="brand-block">
          <p className="eyebrow">Murphy's Cookbook</p>
          <h1>儿童烹饪食谱智能体</h1>
          <p className="muted">
            用现有食材，完成安全、适龄、可执行的亲子料理。
          </p>
        </div>
        <nav className="progress-nav" aria-label="MVP page flow">
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
      <main className="main-panel" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        {children}
      </main>
    </div>
  );
}
