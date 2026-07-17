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
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { MemexMark } from "../lib/icons";
import { useUIStore } from "../stores/uiStore";
import idleMovUrl from "../assets/mascot/idle.mov";
import idleWebmUrl from "../assets/mascot/idle.webm";
import idlePosterUrl from "../assets/mascot/idle.poster.png";

interface ClipSpec {
  mov: string;
  webm: string;
  poster: string;
  /** video display height ÷ box size — centres the character in the square crop. */
  zoom: number;
  /**
   * Whether the clip repeats. `false` is a ONE-SHOT: it plays once and holds
   * its last frame.
   *
   * An ambient clip (idle) loops — it is scenery. A reactive clip (a celebrate
   * on a finished run) must not: a victory dance on a permanent loop stops
   * reading as a reaction and starts reading as a nag, which is the failure mode
   * that killed Clippy. Defaults to true so an ambient clip is the easy case.
   */
  loop?: boolean;
}

// Adding a clip is one entry here plus its three assets (hvc1 .mov, VP9 .webm,
// poster .png) in assets/mascot/ — see docs/mascot-clip-backlog.md.
const CLIPS = {
  // The idle character spans ~71% of the frame height centered; 1.15 makes it
  // fill ~82% of the square crop.
  idle: { mov: idleMovUrl, webm: idleWebmUrl, poster: idlePosterUrl, zoom: 1.15 },
} as const satisfies Record<string, ClipSpec>;
export type MascotClipKey = keyof typeof CLIPS;

// The Tauri shell is ALWAYS WKWebView on macOS — detect the runtime directly
// (its UA may omit the "Safari" token, which mis-routed the shell to the VP9
// webm; WKWebView decodes VP9 WITHOUT alpha, painting an opaque black box).
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// Real Safari browsers carry no Chromium token in the UA.
const SAFARI_ENGINE =
  typeof navigator !== "undefined" &&
  /safari/i.test(navigator.userAgent) &&
  !/chrome|chromium|crios|edg|android/i.test(navigator.userAgent);
const WANTS_HEVC = IS_TAURI || SAFARI_ENGINE;

export default function MascotClip({
  clip = "idle",
  size = 120,
  onEnded,
}: {
  clip?: MascotClipKey;
  /** Square crop size in px; the character fills ~82% of it. */
  size?: number;
  /** Fires when a one-shot clip finishes. Never fires for a looping clip. */
  onEnded?: () => void;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  // A finished one-shot holds its last frame. Tracked in state (not left to the
  // element) so the reduced-motion and error paths render the same still.
  const [ended, setEnded] = useState(false);
  const mascotEnabled = useUIStore((s) => s.mascotEnabled);
  const c: ClipSpec = CLIPS[clip];
  const loops = c.loop ?? true;

  // Swapping the clip restarts it — otherwise a one-shot that already ended
  // would render its predecessor's final frame forever.
  useEffect(() => {
    setEnded(false);
    setFailed(false);
  }, [clip]);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // A one-shot that never plays — reduced motion, a decode error, or the mascot
  // switched off — still has to tell its caller it is over, or anything waiting
  // on the clip waits forever. The still frame IS the whole animation here, so
  // report it finished rather than leaving the caller hanging.
  const willNotPlay = !mascotEnabled || reduced || failed;
  useEffect(() => {
    if (!loops && willNotPlay) onEnded?.();
    // onEnded is intentionally not a dep: callers pass inline closures, and
    // re-firing on every render is exactly what this must not do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, loops, willNotPlay]);
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
      {reduced || failed || ended ? (
        <img src={c.poster} alt="" draggable={false} style={mediaStyle} />
      ) : (
        <video
          src={WANTS_HEVC ? c.mov : c.webm}
          poster={c.poster}
          autoPlay
          loop={loops}
          muted
          playsInline
          onError={() => setFailed(true)}
          onEnded={
            loops
              ? undefined
              : () => {
                  setEnded(true);
                  onEnded?.();
                }
          }
          style={mediaStyle}
        />
      )}
    </span>
  );
}
