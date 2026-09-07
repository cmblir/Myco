import type { JSX } from "react";

export interface CheckProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A real `<input type="checkbox">` wrapped in its own `<label>`, so Space
 * toggles it, the label click target works, and a screen reader announces
 * "checkbox, checked" — all from the platform, none of it re-implemented.
 */
export function Check({
  checked,
  onChange,
  label,
  disabled,
  className,
}: CheckProps): JSX.Element {
  const classes = [
    "u-check",
    checked ? "is-on" : "",
    disabled ? "is-disabled" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <label className={classes}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export default Check;
