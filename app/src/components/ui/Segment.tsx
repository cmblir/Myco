import { useRef } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Shown after the label in the mono face, e.g. a result count. */
  count?: number;
  icon?: ReactNode;
}

export interface SegmentProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers. Required — a bare set of toggles is unreadable. */
  label: string;
  className?: string;
}

/**
 * Which option an arrow key moves to, or `null` when the key is not a
 * navigation key **or** the move would land back on the current option (a
 * one-option group, or Home while already first). Returning `null` for a
 * no-op is what keeps `onChange` firing exactly once per real move.
 *
 * Left/Right wrap, matching a native radio group.
 */
export function nextSegmentIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  let next: number;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      next = (current + 1) % count;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = (current - 1 + count) % count;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = count - 1;
      break;
    default:
      return null;
  }
  return next === current ? null : next;
}

/**
 * A controlled "which view am I in" toggle row. Roving tabindex: the selected
 * option is the group's single tab stop, arrow keys move within it — so Tab
 * passes the whole group by, as it does for a native radio group.
 */
export function Segment<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentProps<T>): JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.value === value);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const next = nextSegmentIndex(event.key, index, options.length);
    if (next === null) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    onChange(options[next].value);
  }

  return (
    <div
      className={["u-segment", className ?? ""].filter(Boolean).join(" ")}
      role="group"
      aria-label={label}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            className="u-segment__btn"
            aria-pressed={active}
            // Nothing is selected yet (an unmatched `value`) → keep the first
            // option reachable rather than stranding the group off the tab order.
            tabIndex={active || (selected === -1 && index === 0) ? 0 : -1}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.icon}
            {option.label}
            {option.count === undefined ? null : (
              <span className="u-segment__count">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default Segment;
