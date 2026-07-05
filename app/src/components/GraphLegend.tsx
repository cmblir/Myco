// In-canvas legend for the 3D graph — the "no unexplained encodings" rule from
// the calm-cosmic-web spec. Bottom-left overlay with two parts:
//  1. Community swatches (top 6 by size): color + representative note + count.
//     Clicking a swatch ISOLATES that community (non-members sink to the faint
//     context layer via the existing hover-highlight machinery); clicking it
//     again releases. The legend doubles as a filter.
//  2. A fixed encoding key: size / dim / amber / neutral.
// Collapsible; starts collapsed on narrow viewports.

import { useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";

export interface LegendCommunity {
  cm: number;
  color: string;
  label: string;
  count: number;
}

export default function GraphLegend({
  t,
  communities,
  isolated,
  onIsolate,
}: {
  t: Strings;
  communities: LegendCommunity[];
  /** Currently isolated community id, or null. */
  isolated: number | null;
  /** Toggle isolation (null releases). */
  onIsolate: (cm: number | null) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 768,
  );

  if (communities.length === 0) return null;

  return (
    <div className="graph-legend" role="region" aria-label={t.gr_legend}>
      <button
        type="button"
        className="graph-legend__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {t.gr_legend} <span className="muted">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <>
          <ul className="graph-legend__communities">
            {communities.map((c) => (
              <li key={c.cm}>
                <button
                  type="button"
                  className={
                    "graph-legend__swatch" +
                    (isolated === c.cm ? " is-active" : "") +
                    (isolated != null && isolated !== c.cm ? " is-dimmed" : "")
                  }
                  title={`${c.label} · ${c.count}`}
                  onClick={() => onIsolate(isolated === c.cm ? null : c.cm)}
                >
                  <span
                    className="graph-legend__dot"
                    style={{ background: c.color }}
                  />
                  <span className="graph-legend__name">{c.label}</span>
                  <span className="muted">{c.count}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="graph-legend__key">
            <div>● {t.gr_key_size ?? "size = links"}</div>
            <div>◐ {t.gr_key_dim ?? "faint = low confidence"}</div>
            <div>
              <span style={{ color: "#ff9e3d" }}>●</span>{" "}
              {t.gr_key_amber ?? "amber = disputed"}
            </div>
            <div>
              <span style={{ color: "#9aa6c2" }}>●</span>{" "}
              {t.gr_key_neutral ?? "grey = unclassified"}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
