// Home statistics and the accessible 7-day activity strip.
import { useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { sparkHeights, type DayBuckets } from "../lib/vaultPulse";
import { useUIStore } from "../stores/uiStore";

interface VaultPulseProps {
  t: Strings;
  pages: number;
  links: number;
  buckets: DayBuckets;
}

export default function VaultPulse({
  t,
  pages,
  links,
  buckets,
}: VaultPulseProps): JSX.Element {
  const authoredWeek = buckets.authored.reduce((sum, n) => sum + n, 0);
  const ingestedWeek = buckets.ingested.reduce((sum, n) => sum + n, 0);
  const heights = sparkHeights(buckets);
  const alt = (t.ov_pulse_alt ?? "{pages} pages, {links} links, {moved} touched this week")
    .replace("{pages}", String(pages))
    .replace("{links}", String(links))
    .replace("{moved}", String(authoredWeek));

  return (
    <section className="vault-pulse" aria-label={alt}>
      <div className="vp-figures">
        <Figure value={pages} label={t.ov_stats_pages} />
        <Figure value={links} label={t.ov_stats_links} />
        <Figure value={authoredWeek} label={t.ov_stats_moved ?? "moved this week"} />
      </div>
      <ActivityStrip
        t={t}
        buckets={buckets}
        heights={heights}
        authoredWeek={authoredWeek}
        ingestedWeek={ingestedWeek}
      />
    </section>
  );
}

function Figure({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div className="vp-figure">
      {/* Grouped: unformatted four-digit figures side by side read as one
          number — the owner's vault showed "2028 133 91" as 202813391. */}
      <div className="vp-value">{value.toLocaleString()}</div>
      <div className="vp-label">{label}</div>
    </div>
  );
}

// The 7-day strip. It used to be seven pairs of 2px stubs, which on a vault
// with a quiet week rendered as specks that read like rendering debris rather
// than a chart — especially against an animated background.
//
// Three changes fix that without inventing data: every day keeps a visible
// TRACK so an empty week reads as "a chart with nothing in it"; each day is a
// real hover/focus target that says what it holds; and the day under the
// pointer is named in the caption instead of only in a tooltip, so the
// information is reachable without a mouse.
function ActivityStrip({
  t,
  buckets,
  heights,
  authoredWeek,
  ingestedWeek,
}: {
  t: Strings;
  buckets: DayBuckets;
  heights: DayBuckets;
  authoredWeek: number;
  ingestedWeek: number;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  // The app's language, not the browser's: ko reads "금 토 일", not "F S S".
  const lang = useUIStore((s) => s.lang);
  const days = heights.authored.length;

  // Oldest bucket first, today last — the same order bucketByDay produces.
  const dayDate = (i: number): Date => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - (days - 1 - i));
    return d;
  };
  const weekday = new Intl.DateTimeFormat(lang, { weekday: "narrow" });
  const full = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" });

  const caption = (): string => {
    if (hover != null) {
      const a = buckets.authored[hover] ?? 0;
      const g = buckets.ingested[hover] ?? 0;
      return `${full.format(dayDate(hover))} · ${a} / ${g}`;
    }
    return authoredWeek === 0
      ? (t.ov_moved_none ?? "Nothing written in the last 7 days")
      : `${authoredWeek} / ${ingestedWeek}`;
  };

  return (
    <div className="vp-activity">
      <div className="vp-spark" onMouseLeave={() => setHover(null)}>
        {heights.authored.map((h, i) => {
          const a = buckets.authored[i] ?? 0;
          const g = buckets.ingested[i] ?? 0;
          return (
            <button
              type="button"
              className={`vp-day${hover === i ? " is-on" : ""}`}
              key={i}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${full.format(dayDate(i))}: ${a} / ${g}`}
            >
              <span className="vp-track">
                <span className="vp-bar-authored" style={{ height: `${h}%` }} />
                <span
                  className="vp-bar-ingested"
                  style={{ height: `${heights.ingested[i] ?? 0}%` }}
                />
              </span>
              <span className="vp-dayname" aria-hidden="true">
                {weekday.format(dayDate(i))}
              </span>
            </button>
          );
        })}
      </div>
      {/* Counts in text, so the chart never encodes meaning in colour and
          height alone. */}
      <p className="vp-caption muted" aria-live="polite">
        {caption()}
      </p>
    </div>
  );
}
