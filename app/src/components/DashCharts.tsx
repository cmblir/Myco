// The dashboard's chart primitives — plain divs, no chart library. Marks
// follow the dataviz mark spec: thin bars with rounded data-ends, a 2px gap
// between adjacent bars, values as text in ink (never inside the series
// color), and a hover title on every mark. Every bar carries its value as a
// visible label: the type palette's purple sits below 3:1 on the dark
// surface, and visible labels are the mandated relief for that.

import type { JSX } from "react";
import type { Channel, DayPoint } from "../lib/board";

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

/** The inflow channels in their VALIDATED fixed order (same palette family
 *  as TYPE_COLORS, first four hues) — color follows the channel, never rank. */
export const CHANNEL_COLORS: Record<Channel, string> = {
  mcp: "var(--c-overview)",
  clipper: "var(--c-entity)",
  voice: "var(--c-concept)",
  import: "var(--c-source)",
};

const dayLabel = (lang: string, day: string): string =>
  new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }).format(
    new Date(`${day}T00:00:00`),
  );

/** Daily columns, stacked by channel when the points carry parts. Labels are
 * selective per the mark spec — peak and today only; every bar answers on
 * hover, and the x-axis names its ends. Stacked segments keep a 2px surface
 * gap; a legend appears only for the multi-series (stacked) case. */
export function DayBars({
  days,
  lang,
  color,
}: {
  days: DayPoint[];
  lang: string;
  /** Single-series override; stacked (parts) days keep channel identity. */
  color?: string;
}): JSX.Element {
  const max = Math.max(1, ...days.map((d) => d.total));
  const peak = days.reduce((a, b) => (b.total > a.total ? b : a), days[0]);
  const stacked = days.some((d) => d.parts && d.parts.length > 0);
  const channels = stacked
    ? (["mcp", "clipper", "voice", "import"] as Channel[]).filter((c) =>
        days.some((d) => (d.parts ?? []).some((p) => p.channel === c && p.value > 0)),
      )
    : [];
  return (
    <div className="dash-fill">
      <div
        className="dash-weeks"
        role="img"
        aria-label={days.map((d) => `${d.day}: ${d.total}`).join(", ")}
      >
        {days.map((d, i) => {
          const last = i === days.length - 1;
          const labeled = (d === peak && d.total > 0) || last;
          return (
            <div
              className="dash-week"
              key={d.day}
              title={`${dayLabel(lang, d.day)} — ${d.total}${
                d.parts
                  ? " (" +
                    d.parts
                      .filter((p) => p.value > 0)
                      .map((p) => `${p.channel} ${p.value}`)
                      .join(" · ") +
                    ")"
                  : ""
              }`}
            >
              {labeled ? <span className="dash-week__num">{d.total}</span> : null}
              {d.parts ? (
                <span
                  className="dash-week__stack"
                  style={{ height: `${Math.max(d.total > 0 ? 2 : 0, (d.total / max) * 100)}%` }}
                >
                  {d.parts
                    .filter((p) => p.value > 0)
                    .map((p) => (
                      <i
                        key={p.channel}
                        style={{
                          flex: p.value,
                          background: CHANNEL_COLORS[p.channel],
                        }}
                      />
                    ))}
                </span>
              ) : (
                <span
                  className={"dash-week__fill" + (last ? " is-current" : "")}
                  style={{
                    height: `${Math.max(d.total > 0 ? 2 : 1, (d.total / max) * 100)}%`,
                    background: color,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="dash-weeks__axis">
        <span>{days[0] ? dayLabel(lang, days[0].day) : ""}</span>
        <span>{days.length > 0 ? dayLabel(lang, days[days.length - 1].day) : ""}</span>
      </div>
      {channels.length > 0 ? (
        <div className="dash-legend">
          {channels.map((c) => (
            <span key={c}>
              <i style={{ background: CHANNEL_COLORS[c] }} /> {c}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Single-series daily line — same data as DayBars, drawn as a 2px path with
 *  the endpoint emphasized. */
export function DayLine({
  days,
  lang,
  color,
}: {
  days: DayPoint[];
  lang: string;
  color?: string;
}): JSX.Element {
  const max = Math.max(1, ...days.map((d) => d.total));
  const W = 100;
  const H = 40;
  const pts = days.map((d, i) => {
    const x = days.length > 1 ? (i / (days.length - 1)) * W : 0;
    const y = H - (d.total / max) * (H - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const last = days[days.length - 1];
  const [lx, ly] = (pts[pts.length - 1] ?? "0,0").split(",").map(Number);
  return (
    <div className="dash-fill">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="dash-line"
        role="img"
        aria-label={days.map((d) => `${d.day}: ${d.total}`).join(", ")}
      >
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke={color ?? "var(--accent)"}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={lx} cy={ly} r="1.6" fill={color ?? "var(--accent)"} />
      </svg>
      <div className="dash-weeks__axis">
        <span>{days[0] ? dayLabel(lang, days[0].day) : ""}</span>
        <span>
          {last ? `${dayLabel(lang, last.day)} · ${last.total}` : ""}
        </span>
      </div>
    </div>
  );
}

/** Label/value rows as a plain table — the "just show me the numbers" view. */
export function CatTable({
  rows,
}: {
  rows: { label: string; value: number }[];
}): JSX.Element {
  return (
    <table className="dash-cattable">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="num">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

