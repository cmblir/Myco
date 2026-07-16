// MYCO — the Memex mascot. Plays the keyed (transparent-background) mascot
// loop on empty/waiting surfaces. Alpha video needs a different codec per
// engine: the Tauri shell is WKWebView (Safari engine) → HEVC+alpha (hvc1
// .mov); a Chromium dev browser → VP9 alpha WebM. The source is picked by
// ENGINE SNIFF rather than <source> fallback on purpose — Chromium can
// hardware-decode hvc1 but WITHOUT its alpha layer, so it would "successfully"
// play the mov with the keyed-out backdrop painted back in.
// Honors prefers-reduced-motion (static poster frame, mirrors ThinkingGalaxy)
// and falls back to the poster if playback errors. The clip frame is a wide
// 16:9; the component crops to a square around the centered character so
// callers just pass one size.
import { useState } from "react";
import type { JSX } from "react";
import { MemexMark } from "../lib/icons";
import { useUIStore } from "../stores/uiStore";
import idleMovUrl from "../assets/mascot/idle.mov";
import idleWebmUrl from "../assets/mascot/idle.webm";
import idlePosterUrl from "../assets/mascot/idle.poster.png";

// zoom: video display height ÷ box size. The idle character spans ~71% of the
// frame height centered; 1.15 makes it fill ~82% of the square crop.
const CLIPS = {
  idle: { mov: idleMovUrl, webm: idleWebmUrl, poster: idlePosterUrl, zoom: 1.15 },
} as const;
export type MascotClipKey = keyof typeof CLIPS;

// WKWebView/Safari carries no Chromium token in its UA.
const SAFARI_ENGINE =
  typeof navigator !== "undefined" &&
  /safari/i.test(navigator.userAgent) &&
  !/chrome|chromium|crios|edg|android/i.test(navigator.userAgent);

export default function MascotClip({
  clip = "idle",
  size = 120,
}: {
  clip?: MascotClipKey;
  /** Square crop size in px; the character fills ~82% of it. */
  size?: number;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const mascotEnabled = useUIStore((s) => s.mascotEnabled);
  const c = CLIPS[clip];
  // Master opt-out (Settings › Appearance): the static logo takes the slot so
  // layouts never shift, the character just stops appearing.
  if (!mascotEnabled) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, display: "grid", placeItems: "center", flexShrink: 0 }}
      >
        <MemexMark size={Math.round(size * 0.66)} />
      </span>
    );
  }
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Absolute centering: with grid/flex a child WIDER than the box grows the
  // track instead of overflowing both sides, so the crop cut only the right
  // half. translate(-50%,-50%) crops symmetrically around the character.
  const mediaStyle = {
    height: size * c.zoom,
    width: "auto",
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
  } as const;
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        overflow: "hidden",
        display: "block",
        position: "relative",
        flexShrink: 0,
      }}
    >
      {reduced || failed ? (
        <img src={c.poster} alt="" draggable={false} style={mediaStyle} />
      ) : (
        <video
          src={SAFARI_ENGINE ? c.mov : c.webm}
          poster={c.poster}
          autoPlay
          loop
          muted
          playsInline
          onError={() => setFailed(true)}
          style={mediaStyle}
        />
      )}
    </span>
  );
}
