import type { ReactNode } from 'react';
import type { PageId } from '../types';

interface AppShellProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  children: ReactNode;
}

const pageOrder: PageId[] = [
  'home',
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
      <main className="main-panel">{children}</main>
    </div>
  );
}
