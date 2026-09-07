import type { JSX, ReactNode } from "react";

export interface RailProps {
  title: string;
  /**
   * Rendered in the mono face beside the title — how many things the rail
   * holds. A string for a ratio ("3/9"), which is a count too.
   */
  count?: number | string;
  /**
   * Collapse. Pass `onToggle` and the head becomes a real toggle button; the
   * open state stays with the caller because every collapsible rail in the app
   * already owns one (a store flag, a viewport default).
   */
  open?: boolean;
  onToggle?: () => void;
  /** Pinned under the scrolling list — a key the list must not scroll away. */
  footer?: ReactNode;
  children?: ReactNode;
}

/**
 * A titled side panel for {@link AppPage}'s `leftRail` / `rightRail`. It fills
 * the grid row it is given and scrolls its own list, so a long rail never
 * stretches the page.
 */
export function Rail({
  title,
  count,
  open,
  onToggle,
  footer,
  children,
}: RailProps): JSX.Element {
  const collapsible = Boolean(onToggle);
  // `open` only means anything alongside `onToggle`; a plain rail is open.
  const shown = !collapsible || open !== false;
  const head = (
    <>
      {collapsible ? (
        <span className="u-rail__caret" aria-hidden="true">
          {shown ? "▾" : "▸"}
        </span>
      ) : null}
      <span className="u-rail__title">{title}</span>
      {count === undefined ? null : (
        <span className="u-rail__count">{count}</span>
      )}
    </>
  );
  return (
    <section className="u-rail">
      {collapsible ? (
        <button
          type="button"
          className="u-rail__head"
          aria-expanded={shown}
          onClick={onToggle}
        >
          {head}
        </button>
      ) : (
        <header className="u-rail__head">{head}</header>
      )}
      {shown ? <div className="u-rail__list">{children}</div> : null}
      {shown && footer ? <div className="u-rail__foot">{footer}</div> : null}
    </section>
  );
}

export interface RailGroupProps {
  label: string;
  count?: number;
  /** A mark before the label — the legend's colour swatch. */
  lead?: ReactNode;
  open: boolean;
  onToggle: () => void;
  title?: string;
  children?: ReactNode;
}

/**
 * A collapsible section *inside* a {@link Rail}. The gaps rail's buckets and
 * the legend's galaxies are the same shape — a caret, a label, a count and an
 * indented list — so they are the same part.
 */
export function RailGroup({
  label,
  count,
  lead,
  open,
  onToggle,
  title,
  children,
}: RailGroupProps): JSX.Element {
  return (
    <div className="u-rail__group">
      <button
        type="button"
        className="u-rail__grouphead"
        aria-expanded={open}
        title={title}
        onClick={onToggle}
      >
        <span className="u-rail__caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {lead}
        <span className="u-rail__name">{label}</span>
        {count === undefined ? null : (
          <span className="u-rail__count">{count}</span>
        )}
      </button>
      {open ? <div className="u-rail__groupbody">{children}</div> : null}
    </div>
  );
}

export interface RailRowProps {
  children?: ReactNode;
  /** Given, the row becomes a real <button>; omitted, it is a plain row. */
  onClick?: () => void;
  active?: boolean;
  className?: string;
  title?: string;
  /**
   * Trailing controls, revealed on hover/focus/selection. A row with actions
   * cannot itself be the button — nested buttons are invalid — so `onClick`
   * moves onto the row's label and the actions sit beside it.
   */
  actions?: ReactNode;
}

/** One row inside a {@link Rail}. */
export function RailRow({
  children,
  onClick,
  active,
  className,
  title,
  actions,
}: RailRowProps): JSX.Element {
  const classes = ["u-rail__row", active ? "is-active" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  if (actions)
    return (
      <div className={classes}>
        {onClick ? (
          <button
            type="button"
            className="u-rail__label"
            title={title}
            onClick={onClick}
          >
            {children}
          </button>
        ) : (
          <span className="u-rail__label">{children}</span>
        )}
        <span className="u-rail__acts">{actions}</span>
      </div>
    );
  if (!onClick)
    return (
      <div className={classes} title={title}>
        {children}
      </div>
    );
  return (
    <button
      type="button"
      className={classes}
      title={title}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default Rail;
