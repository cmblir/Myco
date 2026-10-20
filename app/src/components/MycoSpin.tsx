// The spin viewer (spec 2026-10-04-myco-spin.md): a generated 360° turntable
// video, turned with the mouse (drag + inertia) or the keys (arrows 15°, Home
// the front) by seeking its playhead. Untouched for 4 s it turns slowly on its
// own, except under reduced motion. The video loads only once the viewer is
// on screen; until its first frame it shows the poster, and a video that
// cannot play leaves the still pose. Callers key it by skin, so a new skin
// starts over from its own poster.

import { useEffect, useRef, useState, type JSX } from "react";
import attentionPose from "../assets/mascot/poses/attention.png";
import blackPoster from "../assets/mascot/spin/spin-black.poster.jpg";
import blackVideo from "../assets/mascot/spin/spin-black.mp4";
import whitePoster from "../assets/mascot/spin/spin-white.poster.jpg";
import whiteVideo from "../assets/mascot/spin/spin-white.mp4";
import { STRINGS } from "../lib/i18n";
import type { Myco3DSkin } from "../lib/myco3d";
import {
  dragToTime,
  dragVelocity,
  frameTime,
  idleTurn,
  inertia,
  keyToTime,
} from "../lib/mycoSpin";
import { useUIStore } from "../stores/uiStore";

const SOURCES: Record<Myco3DSkin, { video: string; poster: string }> = {
  black: { video: blackVideo, poster: blackPoster },
  white: { video: whiteVideo, poster: whitePoster },
};
/** A release this long after the last move is a stop, not a fling. */
const FLING_WINDOW_MS = 80;

export function MycoSpin({ skin }: { skin: Myco3DSkin }): JSX.Element {
  const t = STRINGS[useUIStore((s) => s.lang)];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [seen, setSeen] = useState(false);
  const pos = useRef({ t: 0, v: 0, touchedAt: 0 });
  const drag = useRef<{ id: number; x: number; at: number; v: number } | null>(null);

  const failed = status === "error";

  useEffect(() => {
    const video = videoRef.current;
    if (failed || !video) return;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    pos.current.touchedAt = performance.now();
    let onScreen = false;
    let raf = 0;
    let last = 0;
    let shown = -1;
    const show = (): void => {
      const at = frameTime(pos.current.t);
      // Seek only when the frame changes; every frame is a keyframe.
      if (at !== shown && video.readyState >= 1) {
        shown = at;
        video.currentTime = at;
      }
    };
    const frame = (now: number): void => {
      const dt = last ? Math.min(now - last, 100) : 16;
      last = now;
      const p = pos.current;
      if (!drag.current) {
        if (p.v !== 0) {
          const next = inertia(p.t, p.v, dt);
          p.t = next.t;
          p.v = next.v;
          p.touchedAt = now;
        } else {
          p.t = idleTurn(p.t, dt, now - p.touchedAt, motionQuery.matches);
        }
      }
      show();
      raf = onScreen && !document.hidden ? requestAnimationFrame(frame) : 0;
    };
    const wake = (): void => {
      if (!onScreen || document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      } else if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) setSeen(true);
      wake();
    });
    io.observe(video);
    const onMeta = (): void => {
      shown = -1;
      show();
    };
    video.addEventListener("loadedmetadata", onMeta);
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      video.removeEventListener("loadedmetadata", onMeta);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [failed]);

  const touch = (): void => {
    pos.current.touchedAt = performance.now();
  };
  const onPointerDown = (e: React.PointerEvent<HTMLVideoElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, at: e.timeStamp, v: 0 };
    pos.current.v = 0;
    touch();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLVideoElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const width = e.currentTarget.clientWidth;
    pos.current.t = dragToTime(pos.current.t, dx, width);
    const v = dragVelocity(dx, width, e.timeStamp - d.at);
    drag.current = { id: d.id, x: e.clientX, at: e.timeStamp, v };
    touch();
  };
  const onPointerUp = (e: React.PointerEvent<HTMLVideoElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    // Reduced motion: it stops where it is let go, no coasting.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pos.current.v = reduced || e.timeStamp - d.at > FLING_WINDOW_MS ? 0 : d.v;
    touch();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLVideoElement>): void => {
    const next = keyToTime(pos.current.t, e.key);
    if (next === null) return;
    e.preventDefault();
    pos.current = { ...pos.current, t: next, v: 0 };
    touch();
  };

  const { video, poster } = SOURCES[skin];
  if (failed) {
    return (
      <figure className="myco3d myco3d--error">
        <img className="myco3d-still" src={attentionPose} alt="" />
        <figcaption className="myco3d-note" role="status">
          {t.myco_spin_error}
        </figcaption>
      </figure>
    );
  }
  return (
    <div className={`myco-spin myco-spin--${skin}`} data-status={status}>
      <video
        ref={videoRef}
        className="myco-spin-video"
        src={seen ? video : undefined}
        poster={poster}
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        tabIndex={0}
        role="img"
        aria-label={t.myco_spin_label}
        aria-busy={status === "loading"}
        onLoadedData={() => setStatus("ready")}
        onError={() => setStatus("error")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
