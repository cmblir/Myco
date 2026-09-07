import type { CSSProperties, JSX, ReactNode } from "react";

export interface HeroProps {
  /** The 112px glowing object — an ActivityIcon on both of today's heroes. */
  asset: ReactNode;
  /** Small coloured label above the title. Overview's hero has none. */
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  /**
   * The right-hand block: the big number this screen exists to move. Pass the
   * whole block, not the digits — a multi-figure group (Ingest's three verdict
   * counts) brings its own row wrapper.
   */
  figure?: ReactNode;
  /** The screen's one filled primary, stacked under `figure`. */
  action?: ReactNode;
  /** `id` for the `<h1>`, so a page can point `aria-labelledby` at it. */
  titleId?: string;
  /** Anything else that belongs INSIDE the tile — Ingest's dropzone and its
   *  intake channels. Each child is a tile row and keeps its own `--i` stagger. */
  children?: ReactNode;
}

/**
 * The landing tile Overview and Ingest both open with: a glowing 112px asset,
 * a 30px title, a 42px figure and one filled primary, on one glass panel.
 *
 * They were two components with different class names and separately drifting
 * radii, type sizes and paddings — the measured reason the two screens read as
 * two apps. A page still decides what goes in each slot; this decides what a
 * hero *is*.
 */
export function Hero({
  asset,
  eyebrow,
  title,
  lede,
  figure,
  action,
  titleId,
  children,
}: HeroProps): JSX.Element {
  // Custom properties are not in CSSProperties' type, hence the casts. Each
  // tile row rises 40ms after the one before it.
  const step = (i: number) => ({ "--i": i }) as CSSProperties;
  return (
    <section className="u-hero" aria-labelledby={titleId}>
      <div className="u-hero__glow" aria-hidden="true" />
      <div className="u-hero__tile">
        <div className="u-hero__fig" style={step(0)}>
          {asset}
        </div>
        <div className="u-hero__text" style={step(1)}>
          {eyebrow ? <div className="u-hero__eyebrow">{eyebrow}</div> : null}
          <h1 className="u-hero__title" id={titleId}>
            {title}
          </h1>
          {lede ? <p className="u-hero__lede">{lede}</p> : null}
        </div>
        {figure || action ? (
          // One column, right-aligned: the figure and the action it belongs to
          // read as one statement ("4 → 40, harvest 12").
          <div className="u-hero__aside" style={step(2)}>
            {figure}
            {action}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export default Hero;
