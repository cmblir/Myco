import type { CSSProperties, JSX, ReactNode } from "react";

export interface AppPageProps {
  /** Small uppercase label above the title — usually the nav entry this route came from. */
  eyebrow?: string;
  title: string;
  /** Right-aligned controls on the title row: the page's own actions and view switches. */
  tools?: ReactNode;
  /** A full-width toolbar row under the title — filters, a search field, a wide segment. */
  bar?: ReactNode;
  /** One line of orienting copy. Not a place for paragraphs. */
  note?: string;
  leftRail?: ReactNode;
  rightRail?: ReactNode;
  /** Full-width, viewport-height variant. The graph needs it; ordinary pages do not. */
  wide?: boolean;
  /**
   * An extra class on the page root, for a state the whole page enters rather
   * than a slot it fills — the graph's ship mode, which goes app-fullscreen.
   * Not a styling hook: a page that needs one is telling you it wants a slot.
   */
  className?: string;
  children?: ReactNode;
}

/**
 * The `grid-template-columns` a rail combination produces, handed to the body
 * grid as the `--page-cols` custom property rather than as a direct inline
 * `grid-template-columns` — an inline declaration would outrank the media
 * query that stacks the rails on a narrow window.
 */
export function pageGridTemplate(
  hasLeftRail: boolean,
  hasRightRail: boolean,
): string {
  const body = "minmax(0, 1fr)";
  const rail = "var(--rail-w)";
  if (hasLeftRail && hasRightRail) return `${rail} ${body} ${rail}`;
  if (hasLeftRail) return `${rail} ${body}`;
  if (hasRightRail) return `${body} ${rail}`;
  return body;
}

/**
 * The frame every route fills: header row, toolbar row, one-line note, then a
 * body grid of optional rails around the content.
 *
 * It knows nothing about any particular page — no store reads, no route
 * awareness, no page-specific slots. A page decides what goes in `tools` and
 * `bar`; this decides where those live and how they line up with every other
 * route's, which is the whole point.
 */
export function AppPage({
  eyebrow,
  title,
  tools,
  bar,
  note,
  leftRail,
  rightRail,
  wide,
  className,
  children,
}: AppPageProps): JSX.Element {
  // `.workspace` / `.workspace-wide` carry the app's existing page gutters,
  // measure and responsive padding — reused rather than restated here so a
  // migrated page keeps exactly the column it had.
  const shell = [
    wide ? "workspace-wide u-page u-page--wide" : "workspace u-page",
    // Both rails present is the layout that cannot survive a narrow window
    // (a 1000px viewport left the graph's stage 184px wide). The class lets
    // the sheet drop the right rail under the body before the stage becomes
    // a strip; a media query alone cannot ask how many rails there are.
    leftRail && rightRail ? "u-page--rails2" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  // A wide page's stage is its subject, so in source order — which is Tab
  // order — it comes straight after the header, ahead of the bar and the left
  // rail; ui.css restores the visual order with `order` (UX S44: the graph's
  // canvas sat 40 Tabs from its find field).
  const barRow = bar ? <div className="u-page__bar">{bar}</div> : null;
  const noteRow = note ? <p className="u-page__note">{note}</p> : null;
  const leftAside = leftRail ? (
    <aside className="u-page__rail">{leftRail}</aside>
  ) : null;
  return (
    <div className={shell}>
      <header className="u-page__head">
        <div className="u-page__heading">
          {eyebrow ? <div className="u-page__eyebrow">{eyebrow}</div> : null}
          {/* tabIndex -1: focusPageHeading can start the page here. */}
          <h1 className="u-page__title" tabIndex={-1}>
            {title}
          </h1>
        </div>
        {tools ? <div className="u-page__tools">{tools}</div> : null}
      </header>
      {wide ? null : barRow}
      {wide ? null : noteRow}
      <div
        className="u-page__body"
        style={
          {
            "--page-cols": pageGridTemplate(
              Boolean(leftRail),
              Boolean(rightRail),
            ),
          } as CSSProperties
        }
      >
        {wide ? null : leftAside}
        <div className="u-page__main">{children}</div>
        {wide ? leftAside : null}
        {rightRail ? (
          <aside className="u-page__rail u-page__rail--right">
            {rightRail}
          </aside>
        ) : null}
      </div>
      {wide ? barRow : null}
      {wide ? noteRow : null}
    </div>
  );
}

/**
 * After a route change, start the primary pane's page at its title, so Tab
 * goes on from the page rather than from the sidebar row or palette opener
 * that moved it (or the top of the document, when that control unmounted).
 * A field being typed in, or anything inside a dialog, keeps focus (UX S28
 * rule 2). False while the page has no title yet (a lazy route still
 * loading), so the caller can try again.
 */
export function focusPageHeading(
  doc: Pick<Document, "activeElement" | "body" | "querySelector">,
): boolean {
  const active = doc.activeElement;
  if (
    active &&
    active !== doc.body &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) ||
      (active as HTMLElement).isContentEditable ||
      active.closest('dialog, [role="dialog"], [aria-modal="true"]'))
  )
    return true;
  // A note editor already mounted found focus still on the control that
  // moved the page and left it there (focusIsIdle), so it gets focus here.
  const heading =
    doc.querySelector<HTMLElement>(PAGE_EDITOR) ??
    doc.querySelector<HTMLElement>(PAGE_HEADING);
  heading?.focus();
  return heading !== null;
}

/** The primary pane's page title (AppPage's, or the reader's note name). */
export const PAGE_HEADING = ".route-fade h1";

/** The primary pane's writable note editor, when the page has one. */
export const PAGE_EDITOR = '.route-fade .cm-content[contenteditable="true"]';

/**
 * Nobody is using focus: it sits on <body>, or on the page title a route
 * change parked it on. A view that mounts with the cursor ready (the note
 * editor) may take it then, and never from anything else.
 */
export function focusIsIdle(doc: Pick<Document, "activeElement" | "body">): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || active.matches(PAGE_HEADING);
}

export default AppPage;
