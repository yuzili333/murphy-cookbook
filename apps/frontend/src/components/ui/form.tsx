import type { FormHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Form({ className, ...props }: FormHTMLAttributes<HTMLFormElement>) {
  return <form className={cn('ui-form', className)} {...props} />;
}

export function FieldGroup({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('ui-field-group', className)}>{children}</div>;
}

export function Field({ className, children, invalid }: { className?: string; children: ReactNode; invalid?: boolean }) {
  return (
    <div className={cn('ui-field', className)} data-invalid={invalid ? '' : undefined}>
      {children}
    </div>
  );
}

export function FieldLabel({ className, children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('ui-field-label', className)} {...props}>
      {children}
    </label>
  );
}

export function FieldError({ className, children }: { className?: string; children?: ReactNode }) {
  if (!children) return null;
  return <p className={cn('ui-field-error', className)}>{children}</p>;
}
