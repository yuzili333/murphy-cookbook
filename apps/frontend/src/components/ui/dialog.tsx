import type { ReactNode } from 'react';
import { SvgIcon } from '../SvgIcon';
import { cn } from '../../lib/cn';
import { Button } from './button';
import defaultCloseSvg from '../../assets/close.svg?raw';

interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  className?: string;
  hideHeader?: boolean;
  closeButtonAriaLabel?: string;
  closeIconSvg?: string;
  onOpenChange?: (open: boolean) => void;
}

export function Dialog({
  open,
  title,
  children,
  className,
  hideHeader = false,
  closeButtonAriaLabel,
  closeIconSvg,
  onOpenChange,
}: DialogProps) {
  if (!open) return null;
  const resolvedCloseIconSvg = closeIconSvg ?? defaultCloseSvg;

  return (
    <div className="ui-dialog-backdrop" role="presentation">
      <section
        className={cn('ui-dialog-content', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hideHeader ? undefined : 'ui-dialog-title'}
        aria-label={hideHeader ? title : undefined}
      >
        {hideHeader ? (
          onOpenChange ? (
            <button
              type="button"
              className="ui-dialog-floating-close"
              onClick={() => onOpenChange(false)}
              aria-label={closeButtonAriaLabel ?? '关闭'}
            >
              <SvgIcon svg={resolvedCloseIconSvg} />
            </button>
          ) : null
        ) : (
          <div className="ui-dialog-header">
            <h2 id="ui-dialog-title">{title}</h2>
            {onOpenChange ? (
              <Button type="button" variant="ghost" className="close-action-button" onClick={() => onOpenChange(false)}>
                <SvgIcon className="inline-close-icon" svg={resolvedCloseIconSvg} />
                关闭
              </Button>
            ) : null}
          </div>
        )}
        {children}
      </section>
    </div>
  );
}
