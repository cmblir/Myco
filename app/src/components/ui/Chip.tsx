import type { JSX } from "react";

/** `neutral` is silent; the other three each render a dot, so the tone is never colour-only. */
export type ChipTone = "neutral" | "live" | "ok" | "warn";

export interface ChipProps {
  label: string;
  /** Rendered in the mono face — a count, a duration, a short id. */
  value?: string;
  tone?: ChipTone;
  title?: string;
  className?: string;
}

/** A read-only fact, not a control. Use {@link Button} for anything clickable. */
export function Chip({
  label,
  value,
  tone = "neutral",
  title,
  className,
}: ChipProps): JSX.Element {
  const classes = ["u-chip", tone === "neutral" ? "" : `u-chip--${tone}`, className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} title={title}>
      {tone === "neutral" ? null : <span className="u-chip__dot" aria-hidden="true" />}
      {label}
      {value === undefined ? null : <span className="u-chip__value">{value}</span>}
    </span>
  );
}

export default Chip;
