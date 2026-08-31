// The dashboard's chart primitives — plain divs, no chart library. Marks
// follow the dataviz mark spec: thin bars with rounded data-ends, a 2px gap
// between adjacent bars, values as text in ink (never inside the series
// color), and a hover title on every mark. Every bar carries its value as a
// visible label: the type palette's purple sits below 3:1 on the dark
// surface, and visible labels are the mandated relief for that.

import type { JSX } from "react";
import type { WeekBucket } from "../lib/dashboard";

/** The app's page-type colors in their VALIDATED fixed order (dataviz
 * validator, light #fcfcfb + dark #191919): overview → entity → concept →
 * source → analysis → technique keeps every adjacent pair CVD-separable —
 * the raw alphabetical order put technique-red beside entity-green (ΔE 5.0
 * deutan, a fail). Color follows the TYPE, never the row's rank: a vault
 * with no overview pages still paints entity green. */
export const TYPE_COLORS: Record<string, string> = {
  overview: "var(--c-overview)",
  entity: "var(--c-entity)",
  concept: "var(--c-concept)",
  source: "var(--c-source)",
  "source-summary": "var(--c-source)",
  analysis: "var(--c-analysis)",
  technique: "var(--c-technique)",
};

export interface HBarRow {
  label: string;
  count: number;
  /** Identity color; omitted = the single-series accent. */
  color?: string;
}

/** Horizontal bars with the label left, the bar center, the value right —
 * every row hoverable via title. One series (no colors) needs no legend; a
 * colored (categorical) set is identified by its row labels, which sit in
 * ink text, never in the series color. */
export function HBars({ rows }: { rows: HBarRow[] }): JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="dash-hbars">
      {rows.map((r) => (
        <div className="dash-hbar" key={r.label} title={`${r.label}: ${r.count}`}>
          <span className="dash-hbar__label">{r.label}</span>
          <span className="dash-hbar__track">
            <span
              className="dash-hbar__fill"
              style={{
                width: `${Math.max(2, (r.count / max) * 100)}%`,
                background: r.color ?? "var(--accent)",
              }}
            />
          </span>
          <span className="dash-hbar__num">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

/** Weekly activity columns. Labels are selective per the mark spec — only
 * the peak and the current week carry a number; every bar answers on hover.
 * The x-axis names just its ends (first/last Monday) — 26 tick labels on a
 * 300px card is noise. */
export function WeekBars({
  buckets,
  lang,
}: {
  buckets: WeekBucket[];
  lang: string;
}): JSX.Element {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const peak = buckets.reduce((a, b) => (b.count > a.count ? b : a), buckets[0]);
  const day = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" });
  return (
    <div>
      <div className="dash-weeks" role="img" aria-label={buckets.map((b) => `${day.format(new Date(b.startMs))}: ${b.count}`).join(", ")}>
        {buckets.map((b, i) => {
          const last = i === buckets.length - 1;
          const labeled = (b === peak && b.count > 0) || last;
          return (
            <div
              className="dash-week"
              key={b.startMs}
              title={`${day.format(new Date(b.startMs))} — ${b.count}`}
            >
              {labeled ? <span className="dash-week__num">{b.count}</span> : null}
              <span
                className={"dash-week__fill" + (last ? " is-current" : "")}
                style={{ height: `${Math.max(2, (b.count / max) * 100)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="dash-weeks__axis">
        <span>{day.format(new Date(buckets[0]?.startMs ?? 0))}</span>
        <span>{day.format(new Date(buckets[buckets.length - 1]?.startMs ?? 0))}</span>
      </div>
    </div>
  );
}

/** Hero numbers — the "is it even a chart?" answer for single values. */
export function StatTiles({
  tiles,
}: {
  tiles: { label: string; value: number }[];
}): JSX.Element {
  return (
    <div className="dash-tiles">
      {tiles.map((s) => (
        <div className="dash-tile" key={s.label}>
          <span className="dash-tile__value">{s.value}</span>
          <span className="dash-tile__label">{s.label}</span>
        </div>
      ))}
    </div>
  );
}
