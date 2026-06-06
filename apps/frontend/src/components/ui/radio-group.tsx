import { cn } from '../../lib/cn';

interface RadioGroupOption<T extends string> {
  label: string;
  value: T;
}

interface RadioGroupProps<T extends string> {
  value: T;
  options: Array<RadioGroupOption<T>>;
  ariaLabelledBy?: string;
  className?: string;
  onValueChange: (value: T) => void;
}

export function RadioGroup<T extends string>({ value, options, ariaLabelledBy, className, onValueChange }: RadioGroupProps<T>) {
  return (
    <div className={cn('ui-radio-group', className)} role="radiogroup" aria-labelledby={ariaLabelledBy}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className="ui-radio-item"
          onClick={() => onValueChange(option.value)}
        >
          <span className="ui-radio-dot" />
          {option.label}
        </button>
      ))}
    </div>
  );
}
