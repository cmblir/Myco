// The dashboard's ambient layer: the vault's numbers, a particle field whose
// size tracks how linked the vault is, and a 7-day sparkline.
//
// All motion is CSS. Data reaches the keyframes through three custom
// properties set once on the wrapper, so nothing here runs per frame — see
// `lib/vaultPulse.ts` for how the three values are derived.

import { useMemo } from "react";
import type { CSSProperties, JSX } from "react";
import type { Strings } from "../lib/i18n";
import { motionVars, type DayBuckets } from "../lib/vaultPulse";

interface VaultPulseProps {
  t: Strings;
  pages: number;
  links: number;
  buckets: DayBuckets;
  /** 0..1 — share of wikilinks that resolve. */
  resolvedRatio: number;
}

export default function VaultPulse({
  t,
  pages,
  links,
  buckets,
  resolvedRatio,
}: VaultPulseProps): JSX.Element {
  const authoredWeek = buckets.authored.reduce((s, n) => s + n, 0);
  const ingestedWeek = buckets.ingested.reduce((s, n) => s + n, 0);
  const vars = useMemo(
    () => motionVars(links, authoredWeek, resolvedRatio),
    [links, authoredWeek, resolvedRatio],
  );

  // Custom properties are not in CSSProperties' type, hence the cast. Values
  // are plain numbers/strings — nothing user-controlled reaches CSS here.
  const style = {
    "--vault-particles": vars.particles,
    "--vault-pulse": `${vars.pulseMs}ms`,
    "--vault-glow": vars.glow,
  } as CSSProperties;

  const peak = Math.max(1, ...buckets.authored, ...buckets.ingested);
  const alt = (t.ov_pulse_alt ?? "{pages} pages, {links} links, {moved} touched this week")
    .replace("{pages}", String(pages))
    .replace("{links}", String(links))
    .replace("{moved}", String(authoredWeek));

  return (
    <section className="vault-pulse" style={style} aria-label={alt}>
      <div className="vp-figures">
        <Figure value={pages} label={t.ov_stats_pages} />
        <Figure value={links} label={t.ov_stats_links} />
        <Figure value={authoredWeek} label={t.ov_stats_moved ?? "moved this week"} />
      </div>

      {/* Decorative: the numbers above and the sparkline below carry the same
          information, so a screen reader gains nothing from the dots. */}
      <div className="vp-field" aria-hidden="true">
        {Array.from({ length: vars.particles }, (_, i) => (
          <span
            className="vp-dot"
            key={i}
            // Spread the phase so the field drifts instead of pulsing in
            // lockstep. Deterministic — no Math.random, so re-renders do not
            // reshuffle the field under the user.
            style={{ "--i": i } as CSSProperties}
          />
        ))}
      </div>

      <div className="vp-spark">
        {buckets.authored.map((n, i) => (
          <span className="vp-bar" key={i}>
            <span
              className="vp-bar-authored"
              style={{ height: `${(n / peak) * 100}%` }}
            />
            <span
              className="vp-bar-ingested"
              style={{ height: `${((buckets.ingested[i] ?? 0) / peak) * 100}%` }}
            />
          </span>
        ))}
      </div>
      {/* The count in text, so the chart never encodes meaning in colour and
          height alone. */}
      <p className="vp-caption muted">
        {authoredWeek === 0
          ? (t.ov_moved_none ?? "Nothing written in the last 7 days")
          : `${authoredWeek} / ${ingestedWeek}`}
      </p>
    </section>
  );
}

function Figure({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div className="vp-figure">
      <div className="vp-value">{value}</div>
      <div className="vp-label">{label}</div>
    </div>
  );
}
