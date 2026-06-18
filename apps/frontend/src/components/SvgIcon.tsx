import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

interface SvgIconProps extends HTMLAttributes<HTMLSpanElement> {
  svg: string;
}

export function SvgIcon({ svg, className, ...props }: SvgIconProps) {
  return (
    <span
      className={cn('svg-icon', className)}
      aria-hidden="true"
      {...props}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
