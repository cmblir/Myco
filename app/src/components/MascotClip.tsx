// MYCO — the mascot the product is named after. Plays a keyed
// (transparent-background) clip from lib/mascotClips on empty, waiting and
// reacting surfaces; that module owns the clip table, the engine sniff and the
// rules for when a clip may play.
// Honors prefers-reduced-motion (static poster frame, mirrors ThinkingGalaxy)
// and falls back to the poster if playback errors. It plays only while the
// window is shown and the slot is on screen. The idle frame is a wide 16:9;
// the component crops to a square around the centered character so callers
// just pass one size.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { MycoMark } from "../lib/icons";
import { useUIStore } from "../stores/uiStore";
import { CLIPS, clipView, playbackRef, wantsHevc } from "../lib/mascotClips";
import type { ClipSpec, MascotClipKey } from "../lib/mascotClips";

export type { MascotClipKey };

const WANTS_HEVC = wantsHevc();

export default function MascotClip({
  clip = "idle",
  size = 120,
  held = false,
  onEnded,
}: {
  clip?: MascotClipKey;
  /** Square box in px. idle's character fills ~82% of it, a krea clip's
   *  ~64% (the rest is room for its hops and props). */
  size?: number;
  /** Show the still and never play: the moment this one-shot marks is
   *  already over (the Ingest hero coming back to a finished run). */
  held?: boolean;
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
  // Held lives here, not in `ended`'s initial state: the [clip] effect above
  // resets `ended` as the clip mounts.
  const view = clipView({ mascotEnabled, reduced, failed, ended: ended || held });
  // A one-shot that never plays — reduced motion, a decode error, the mascot
  // switched off, or held — still has to tell its caller it is over, or
  // anything waiting on the clip waits forever. The still frame IS the whole
  // animation here, so report it finished rather than leaving the caller hanging.
  const willNotPlay = !mascotEnabled || reduced || failed || held;
  useEffect(() => {
    if (!loops && willNotPlay) onEnded?.();
    // onEnded is intentionally not a dep: callers pass inline closures, and
    // re-firing on every render is exactly what this must not do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, loops, willNotPlay]);
  // Master opt-out (Settings › Appearance): the static logo takes the slot so
  // layouts never shift, the character just stops appearing.
  // MYCO must never appear as a play button.
  //
  // Catching a rejected play() was not enough: WKWebView also draws its play
  // glyph over a video that ACCEPTED play() but never actually produced frames
  // (a stalled HEVC-alpha decode does exactly this), and no error or rejection
  // fires in that case.
  //
  // So the video is never the visible element until it has proven it is
  // playing. The poster renders first; the <video> sits underneath at zero
  // opacity and only fades in on its own `playing` event. A clip that never
  // plays therefore stays a poster forever, which is the desired outcome and
  // cannot show a control.
  const [playing, setPlaying] = useState(false);
  // Window and viewport visibility, bound to each <video> as it mounts. The
  // video is keyed by clip, so a swapped clip is a new element: it is bound
  // again, and the one it replaces resets `playing` as it goes.
  const [videoRef] = useState(() =>
    playbackRef(
      () => setFailed(true),
      () => setPlaying(false),
    ),
  );

  if (view === "mark") {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, display: "grid", placeItems: "center", flexShrink: 0 }}
      >
        <MycoMark size={Math.round(size * 0.66)} />
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
      {/* The poster is what shows before the first frame arrives, and what
          remains if the clip never plays. It stays MOUNTED once playback
          starts (so a stall falls back to it without a flash) but must go
          INVISIBLE: the clip is alpha-keyed, so a lit poster shows through
          every transparent pixel and the character reads as two overlapping
          copies of itself the moment it moves. A finished one-shot unmounts
          its video, so the poster has to come back then. */}
      <img
        src={c.poster}
        alt=""
        draggable={false}
        style={{ ...mediaStyle, opacity: playing && view === "video" ? 0 : 1 }}
      />
      {view !== "video" ? null : (
        <video
          key={clip}
          ref={videoRef}
          onPlaying={() => setPlaying(true)}
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
          style={{ ...mediaStyle, opacity: playing ? 1 : 0 }}
        />
      )}
    </span>
  );
}
