import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';

interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}

export function Dialog({ open, title, children, className, onOpenChange }: DialogProps) {
  if (!open) return null;

  return (
    <div className="ui-dialog-backdrop" role="presentation">
      <section className={cn('ui-dialog-content', className)} role="dialog" aria-modal="true" aria-labelledby="ui-dialog-title">
        <div className="ui-dialog-header">
          <h2 id="ui-dialog-title">{title}</h2>
          {onOpenChange ? (
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          ) : null}
        </div>
        {children}
      </section>
    </div>
  );
}
