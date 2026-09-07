import type { JSX, ReactNode } from "react";

export interface RailProps {
  title: string;
  /** Rendered in the mono face beside the title — how many things the rail holds. */
  count?: number;
  children?: ReactNode;
}

/**
 * A titled side panel for {@link AppPage}'s `leftRail` / `rightRail`. It fills
 * the grid row it is given and scrolls its own list, so a long rail never
 * stretches the page.
 */
export function Rail({ title, count, children }: RailProps): JSX.Element {
  return (
    <section className="u-rail">
      <header className="u-rail__head">
        <span className="u-rail__title">{title}</span>
        {count === undefined ? null : (
          <span className="u-rail__count">{count}</span>
        )}
      </header>
      <div className="u-rail__list">{children}</div>
    </section>
  );
}

export interface RailRowProps {
  children?: ReactNode;
  /** Given, the row becomes a real <button>; omitted, it is a plain row. */
  onClick?: () => void;
  active?: boolean;
  className?: string;
}

/** One row inside a {@link Rail}. */
export function RailRow({
  children,
  onClick,
  active,
  className,
}: RailRowProps): JSX.Element {
  const classes = ["u-rail__row", active ? "is-active" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  if (!onClick) return <div className={classes}>{children}</div>;
  return (
    <button
      type="button"
      className={classes}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default Rail;
