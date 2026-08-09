// The dashboard's ambient layer: the vault's numbers, a living background the
// user picks in Settings, and a 7-day sparkline.
//
// The background is one of the graph's layout names rendered as ambient motion
// (see `lib/overviewThemes.ts`). It runs on a canvas rather than CSS keyframes
// because several themes hold state between frames — growth that leaves a
// trail, a signal travelling along an edge — which keyframes cannot express.
// One rAF loop, stopped whenever the tab is hidden or the OS asks for reduced
// motion. `lib/vaultPulse.ts` still derives how MUCH to draw and how fast, so
// changing the look never changes what the screen says about the vault.

import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties, JSX } from "react";
import type { Strings } from "../lib/i18n";
import { motionVars, sparkHeights, type DayBuckets } from "../lib/vaultPulse";
import { createOverviewEngine } from "../lib/overviewThemes";
import { useUIStore } from "../stores/uiStore";

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

  const themeKey = useUIStore((s) => s.overviewTheme);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Custom properties are not in CSSProperties' type, hence the cast. Values
  // are plain numbers/strings — nothing user-controlled reaches CSS here.
  const style = {
    "--vault-glow": vars.glow,
  } as CSSProperties;

  // pulseMs is a full heartbeat (6s idle → 1.8s busy); the engines want a plain
  // 0.35..1 rate, so invert it here rather than teaching every engine the unit.
  const speed = useMemo(() => {
    const busy = (6000 - vars.pulseMs) / (6000 - 1800);
    return 0.35 + Math.max(0, Math.min(1, busy)) * 0.65;
  }, [vars.pulseMs]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return; // no 2D context (very old webview) — the numbers still render

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const engine = createOverviewEngine(themeKey, { count: vars.particles, speed });
    let raf = 0;
    let last = 0;
    let stopped = false;

    // Size to the element's CSS box, capped at 2x: a retina canvas at 3x costs
    // 2.25x the fill rate for no visible gain on an ambient background.
    const fit = (): { w: number; h: number } => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = cv.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr;
        cv.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    };

    const frame = (ts: number): void => {
      if (stopped) return;
      const dt = last ? Math.min((ts - last) / 1000, 0.05) : 0.016;
      last = ts;
      const { w, h } = fit();
      // Trail engines paint over their own previous frame; clearing would erase
      // exactly the growth they exist to show.
      if (!engine.trails) ctx.clearRect(0, 0, w, h);
      engine.step(ctx, w, h, dt);
      raf = requestAnimationFrame(frame);
    };

    // Paint one frame regardless, so reduced-motion still shows the field —
    // a still field carries "this vault has many links" just as well.
    const { w, h } = fit();
    if (engine.trails) {
      ctx.clearRect(0, 0, w, h);
    }
    engine.step(ctx, w, h, 0.016);
    if (!reduced) raf = requestAnimationFrame(frame);

    const onVisibility = (): void => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!reduced && !raf && !stopped) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [themeKey, vars.particles, speed]);

  // See `sparkHeights` for why each series scales against its own peak
  // instead of a shared one.
  const heights = sparkHeights(buckets);
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
          information, so a screen reader gains nothing from the background. */}
      <canvas className="vp-canvas" ref={canvasRef} aria-hidden="true" />

      <div className="vp-spark">
        {heights.authored.map((h, i) => (
          <span className="vp-bar" key={i}>
            <span className="vp-bar-authored" style={{ height: `${h}%` }} />
            <span
              className="vp-bar-ingested"
              style={{ height: `${heights.ingested[i] ?? 0}%` }}
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
