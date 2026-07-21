// MYCO's graph cameo — the planet mushroom drifts into the graph cosmos on a
// rare timer and floats a one-line feature tip beside it, then fades out. The
// graph is the one surface where an unprompted appearance reads as delight, not
// a Clippy interruption (it's a play space, not a work surface) — but it is
// still gated three ways: the `mascotCameo` graph setting, the global
// `mascotEnabled` opt-out, and prefers-reduced-motion (no surprise motion).
//
// A self-contained DOM overlay rather than a 3D sprite: the whole point is the
// speech-bubble tip, which is DOM anyway, and the transparent video floats over
// the cosmic canvas so it still reads as "in the graph".

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useUIStore } from "../stores/uiStore";
import type { Strings } from "../lib/i18n";
import planetMovUrl from "../assets/mascot/planet.mov";
import planetWebmUrl from "../assets/mascot/planet.webm";
import planetPosterUrl from "../assets/mascot/planet.poster.png";

// Same engine sniff as MascotClip: WKWebView (Tauri) / Safari need the HEVC
// .mov for its alpha; Chromium decodes hvc1 WITHOUT alpha (opaque box), so it
// takes the VP9 alpha .webm. Never a <source> fallback — the wrong one "works"
// and paints the keyed-out backdrop back in.
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const SAFARI_ENGINE =
  typeof navigator !== "undefined" &&
  /safari/i.test(navigator.userAgent) &&
  !/chrome|chromium|crios|edg|android/i.test(navigator.userAgent);
const WANTS_HEVC = IS_TAURI || SAFARI_ENGINE;

// Cadence: a first appearance soon enough to be discovered, then rare so it
// never nags. Randomised so it doesn't feel scheduled.
const FIRST_MIN = 22_000;
const FIRST_MAX = 45_000;
const GAP_MIN = 140_000;
const GAP_MAX = 300_000;
const HOLD_MS = 13_000; // how long a cameo stays before drifting out

function tips(t: Strings): string[] {
  return [
    t.mc_tip_drag ?? "Drag any star and the simulation re-heats — its neighbours follow, then spring back.",
    t.mc_tip_path ?? "Cmd/Ctrl-click two notes to light the shortest path between them.",
    t.mc_tip_fly ?? "Press F to pilot a spaceship through your vault — WASD to fly, Esc to land.",
    t.mc_tip_looks ?? "Open the settings panel and tap a Look — Sigma, Paper, Neural, Planetarium…",
    t.mc_tip_timelapse ?? "Play the Timelapse to watch your vault build itself in the order you wrote it.",
    t.mc_tip_multiverse ?? "Turn on Multiverse to see every project as its own glowing universe-bubble.",
    t.mc_tip_minimap ?? "That corner minimap? Click anywhere on it to fly the camera there.",
    t.mc_tip_recency ?? "Recently edited notes burn hotter — the graph maps where your attention is.",
    t.mc_tip_save ?? "Tuned a look you love? Name it under Saved looks and recall it with one tap.",
    t.mc_tip_chronicle ?? "Try the Chronicle layout — your notes laid out along a real time axis.",
  ];
}

export default function MascotCameo({
  enabled,
  t,
}: {
  /** The `mascotCameo` graph setting. */
  enabled: boolean;
  t: Strings;
}): JSX.Element | null {
  const mascotEnabled = useUIStore((s) => s.mascotEnabled);
  const [visible, setVisible] = useState(false);
  const [tip, setTip] = useState("");
  const [leaving, setLeaving] = useState(false);
  const tipIdx = useRef(0);
  const holdTimer = useRef<number | null>(null);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const active = enabled && mascotEnabled && !reduced;

  const dismiss = useCallback(() => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    // Play the exit, then unmount the video a beat later.
    setLeaving(true);
    window.setTimeout(() => {
      setVisible(false);
      setLeaving(false);
    }, 520);
  }, []);

  const show = useCallback(() => {
    const list = tips(t);
    // Rotate deterministically so a session sees a spread of tips, not repeats.
    setTip(list[tipIdx.current % list.length]);
    tipIdx.current += 1;
    setLeaving(false);
    setVisible(true);
    holdTimer.current = window.setTimeout(dismiss, HOLD_MS);
  }, [t, dismiss]);

  // The appearance scheduler. One self-rescheduling timeout chain so the gap
  // after each cameo is randomised; cleared entirely when inactive.
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    let killed = false;
    let timer: number;
    const rand = (a: number, b: number): number => a + (b - a) * fractionalNow();
    const schedule = (delay: number): void => {
      timer = window.setTimeout(() => {
        if (killed) return;
        show();
        schedule(rand(GAP_MIN, GAP_MAX));
      }, delay);
    };
    schedule(rand(FIRST_MIN, FIRST_MAX));
    // DEV: let the screenshot harness trigger a cameo on demand.
    if (import.meta.env.DEV) {
      (window as unknown as { __mascotCameo?: () => void }).__mascotCameo = show;
    }
    return () => {
      killed = true;
      window.clearTimeout(timer);
      if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
    };
  }, [active, show]);

  if (!visible) return null;

  return (
    <div
      className={`mascot-cameo${leaving ? " mascot-cameo--leaving" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="mascot-cameo__bubble">
        <span className="mascot-cameo__label">{t.mc_label ?? "MYCO tip"}</span>
        <p className="mascot-cameo__tip">{tip}</p>
        <button
          type="button"
          className="mascot-cameo__dismiss"
          onClick={dismiss}
          aria-label={t.mc_dismiss ?? "Dismiss"}
        >
          ×
        </button>
      </div>
      <video
        className="mascot-cameo__video"
        src={WANTS_HEVC ? planetMovUrl : planetWebmUrl}
        poster={planetPosterUrl}
        autoPlay
        loop
        muted
        playsInline
        draggable={false}
        onClick={dismiss}
      />
    </div>
  );
}

// Wall-clock fraction of the current second — a cheap, dependency-free jitter
// source (Math.random would do too; this keeps the value stable within a tick).
function fractionalNow(): number {
  const ms = Date.now() % 1000;
  return ms / 1000;
}
