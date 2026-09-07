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
  children,
}: AppPageProps): JSX.Element {
  // `.workspace` / `.workspace-wide` carry the app's existing page gutters,
  // measure and responsive padding — reused rather than restated here so a
  // migrated page keeps exactly the column it had.
  const shell = wide
    ? "workspace-wide u-page u-page--wide"
    : "workspace u-page";
  return (
    <div className={shell}>
      <header className="u-page__head">
        <div className="u-page__heading">
          {eyebrow ? <div className="u-page__eyebrow">{eyebrow}</div> : null}
          <h1 className="u-page__title">{title}</h1>
        </div>
        {tools ? <div className="u-page__tools">{tools}</div> : null}
      </header>
      {bar ? <div className="u-page__bar">{bar}</div> : null}
      {note ? <p className="u-page__note">{note}</p> : null}
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
        {leftRail ? <aside className="u-page__rail">{leftRail}</aside> : null}
        <div className="u-page__main">{children}</div>
        {rightRail ? <aside className="u-page__rail">{rightRail}</aside> : null}
      </div>
    </div>
  );
}

export default AppPage;
