// MYCO's graph cameo — the planet mushroom drifts through the graph COSMOS as a
// planet (sized by perspective, parallaxing when the camera orbits) and floats a
// one-line feature tip beside it, then fades out. It belongs to the 3D cosmos
// only: on a flat 2D chart a floating planet is incongruous, so it never appears
// there. The mascot is a DOM <video> (reliable transparent-video alpha, unlike a
// WebGL VideoTexture) whose screen position AND size are driven by a 3D world
// anchor projected through the live camera — so it sits IN the scene as a world,
// not as a fixed HUD sprite.
//
// Gated four ways: the `mascotCameo` graph setting, the global `mascotEnabled`
// opt-out, prefers-reduced-motion (no surprise motion), and a live 3D-layout
// check (`active` is cleared by the parent for 2D / multiverse / light skins).

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useUIStore } from "../stores/uiStore";
import type { Strings } from "../lib/i18n";
import planetMovUrl from "../assets/mascot/planet.mov";
import planetWebmUrl from "../assets/mascot/planet.webm";
import planetPosterUrl from "../assets/mascot/planet.poster.png";

// Same engine sniff as MascotClip: WKWebView (Tauri) / Safari need the HEVC .mov
// for its alpha; Chromium the VP9 .webm (a wrong <source> fallback paints the
// keyed-out backdrop back in).
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const SAFARI_ENGINE =
  typeof navigator !== "undefined" &&
  /safari/i.test(navigator.userAgent) &&
  !/chrome|chromium|crios|edg|android/i.test(navigator.userAgent);
const WANTS_HEVC = IS_TAURI || SAFARI_ENGINE;

// Cadence: a first appearance soon enough to be discovered, then rare so it
// never nags.
const FIRST_MIN = 22_000;
const FIRST_MAX = 45_000;
const GAP_MIN = 140_000;
const GAP_MAX = 300_000;
const HOLD_MS = 13_000;

// Planet world radius as a fraction of the framed distance, and the video-frame
// height needed to render a planet of that radius (the planet fills ~half the
// 16:9 clip). Tuned so the cameo reads as a mid-size world at the fitted zoom.
const WORLD_FRAC = 0.12;
const FRAME_TO_PLANET = 4.0; // video height ÷ planet diameter

// The minimal slice of GraphScene the cameo needs — projection of a world anchor.
interface MascotScene {
  is3D(): boolean;
  getFramedDist(): number;
  mascotSpawnPoint(): { x: number; y: number; z: number };
  projectPoint(p: { x: number; y: number; z: number }): {
    sx: number;
    sy: number;
    pxPerWorld: number;
    visible: boolean;
  };
}

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
  active,
  sceneRef,
  t,
}: {
  /** Parent gate: mascotCameo setting AND a 3D dark cosmos (not 2D / multiverse
   *  / light skin). The component adds mascotEnabled + reduced-motion. */
  active: boolean;
  sceneRef: React.RefObject<MascotScene | null>;
  t: Strings;
}): JSX.Element | null {
  const mascotEnabled = useUIStore((s) => s.mascotEnabled);
  const [visible, setVisible] = useState(false);
  const [tip, setTip] = useState("");
  const [leaving, setLeaving] = useState(false);
  const tipIdx = useRef(0);
  const holdTimer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  // The world anchor the planet drifts along, and its base world radius.
  const anchor = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });
  const worldR = useRef(40);
  const rafRef = useRef<number | null>(null);
  const driftRef = useRef(0);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canRun = active && mascotEnabled && !reduced;

  const stopRaf = (): void => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  const dismiss = useCallback(() => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    setLeaving(true);
    window.setTimeout(() => {
      stopRaf();
      setVisible(false);
      setLeaving(false);
    }, 520);
  }, []);

  // Per-frame: drift the world anchor, re-project it through the live camera,
  // and place + size the planet (and its tip) accordingly. Uses direct DOM style
  // writes (not React state) so orbiting stays smooth.
  const frame = useCallback(() => {
    rafRef.current = requestAnimationFrame(frame);
    const scene = sceneRef.current;
    const root = rootRef.current;
    if (!scene || !root) return;
    // Bail out to a dismiss if the layout left 3D under us.
    if (!scene.is3D()) {
      dismiss();
      return;
    }
    driftRef.current += 0.0035;
    const a = anchor.current;
    const drifted = {
      x: a.x + Math.sin(driftRef.current) * worldR.current * 0.5,
      y: a.y + Math.cos(driftRef.current * 0.8) * worldR.current * 0.35,
      z: a.z,
    };
    const pr = scene.projectPoint(drifted);
    // Off-screen / behind the camera → hide without disturbing the fade anim.
    root.style.visibility = pr.visible ? "visible" : "hidden";
    if (!pr.visible) return;
    // The anchor point IS the planet centre; the 0-size root sits there and the
    // video is centred on it. Planet diameter in px comes from perspective; the
    // 16:9 clip frame is ~2× the planet (it fills ~half the frame height).
    const planetPx = 2 * worldR.current * pr.pxPerWorld;
    const frameH = Math.max(70, Math.min(planetPx * (FRAME_TO_PLANET / 2), 520));
    const frameW = (frameH * 16) / 9;
    root.style.left = `${pr.sx}px`;
    root.style.top = `${pr.sy}px`;
    const v = videoRef.current;
    if (v) v.style.height = `${frameH}px`;
    // Bubble sits to the LEFT of the planet, its right edge clearing the planet.
    const b = bubbleRef.current;
    if (b) b.style.right = `${frameW * 0.42 + 8}px`;
  }, [sceneRef, dismiss]);

  const show = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene || !scene.is3D()) return;
    anchor.current = scene.mascotSpawnPoint();
    worldR.current = Math.max(20, scene.getFramedDist() * WORLD_FRAC);
    driftRef.current = 0;
    const list = tips(t);
    setTip(list[tipIdx.current % list.length]);
    tipIdx.current += 1;
    setLeaving(false);
    setVisible(true);
    holdTimer.current = window.setTimeout(dismiss, HOLD_MS);
    stopRaf();
    rafRef.current = requestAnimationFrame(frame);
  }, [sceneRef, t, dismiss, frame]);

  // Appearance scheduler — one self-rescheduling chain so each gap is randomised.
  useEffect(() => {
    if (!canRun) {
      stopRaf();
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
    if (import.meta.env.DEV) {
      (window as unknown as { __mascotCameo?: () => void }).__mascotCameo = show;
    }
    return () => {
      killed = true;
      window.clearTimeout(timer);
      if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
      stopRaf();
    };
  }, [canRun, show]);

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      className={`mascot-cameo${leaving ? " mascot-cameo--leaving" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div ref={bubbleRef} className="mascot-cameo__bubble">
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
        ref={videoRef}
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

// Wall-clock fraction of the current second — a cheap jitter source.
function fractionalNow(): number {
  return (Date.now() % 1000) / 1000;
}
