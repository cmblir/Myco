// myco in the notch (spec: docs/specs/2026-10-02-notch-mascot.md). Three
// layers, so it stays one character whatever it does:
//   1. the pose — a character-sheet pose with its eyes painted out
//      (scripts/gen-notch-mascot.py), or a krea.ai clip while one plays;
//   2. procedural eyes — SVG ovals at the pose's measured eye anchors, which
//      blink, follow the cursor, squint, spiral and close;
//   3. one spring transform on the whole sprite — squash, hop, sigh, shake.
// Idle costs no JS frames: breathing is a CSS animation and blinking a Web
// Animations cycle, both compositor-run; one timeout arms the doze, and every
// clip (the doze loop too) is a Web Animations walk along its strip. A rAF
// runs only while a spring is moving, the eyes are tracking, or the voice
// level drives the cap glow.
// Decorative (aria-hidden): the notch's text stays the source of status.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, JSX } from "react";
import {
  DOZE_AFTER_MS,
  LOOK_REST,
  REACTIONS,
  SPRING_REST,
  blinkKeyframes,
  clipEnded,
  clipFrame,
  clipsAhead,
  clipNow,
  dozeArmed,
  dozeOff,
  enterRun,
  eyesFor,
  glowFor,
  glowFromLevel,
  hasFx,
  kick,
  lookOffset,
  lookStep,
  mascotBehaviour,
  pointerAim,
  resolveClip,
  settled,
  socketFor,
  stepAll,
  stillAfter,
  stillBefore,
} from "../lib/notchMascot";
import type {
  ClipRun,
  ClipSpec,
  EyeAnchor,
  EyeMode,
  MascotClipName,
  MascotKind,
  MascotPose,
  MascotSprings,
} from "../lib/notchMascot";
import type { LevelHistory } from "../lib/voiceLevel";

const LAYERS = import.meta.glob<string>("../assets/mascot/notch/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});
// The keyed krea.ai clips (decision 4, the motion library). A missing pair
// resolves to null and that state runs on procedural motion alone.
const CLIP_MANIFESTS = import.meta.glob("../assets/mascot/motion/*.json", {
  eager: true,
});
const CLIP_STRIPS = import.meta.glob<string>("../assets/mascot/motion/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});

function layer(pose: MascotPose, px: 64 | 128, fx = false): string {
  return (
    LAYERS[`../assets/mascot/notch/${pose}${fx ? "-fx" : ""}.${px}.png`] ?? ""
  );
}

/** Where it stands: at the open card's leading edge or roaming the screen
 *  (RoamWindow). The collapsed menu bar has no visible mascot. */
export type MascotPlacement = "panel" | "roam";
const PLACEMENT_PX: Record<MascotPlacement, number> = {
  panel: 56,
  roam: 64,
};

/** Any seed works; one fixed seed keeps the rhythm the same every launch. */
const BLINK_SEED = 20261002;

const REST: MascotSprings = {
  x: { x: 0, v: 0 },
  y: { x: 0, v: 0 },
  sx: { x: 1, v: 0 },
  sy: { x: 1, v: 0 },
  r: { x: 0, v: 0 },
};

/** A clip from the motion library, or null while its pair is not shipped. */
export const resolveShipped = (name: MascotClipName): ClipSpec | null =>
  resolveClip(name, CLIP_MANIFESTS, CLIP_STRIPS);

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** useSyncExternalStore's two halves for prefers-reduced-motion. Subscribed,
 *  a flip mid-clip re-renders: the strip, the blink cycle and the doze clock
 *  stop with it, rather than whenever something else re-renders. */
export function subscribeReducedMotion(onChange: () => void): () => void {
  const m = window.matchMedia(REDUCED_MOTION);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION).matches
  );
}

export default function NotchMascot({
  kind,
  placement,
  levels,
}: {
  kind: MascotKind;
  placement: MascotPlacement;
  /** Mic history while recording: the cap glow follows the voice. */
  levels?: LevelHistory;
}): JSX.Element {
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
  );
  const b = mascotBehaviour(kind);
  const [reaction, setReaction] = useState<keyof typeof REACTIONS | null>(null);
  // accepted catches as attention, then settles to success.
  const [entering, setEntering] = useState(false);
  // The clips this state plays and how far they have got. Moved on during
  // render, not in an effect, so a new state's first frame never shows the
  // last state's clip.
  const [run, setRun] = useState<ClipRun>(() => enterRun(null, kind));
  if (run.kind !== kind) setRun(enterRun(run, kind));
  // A hidden window plays nothing and runs no doze clock.
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  // Strips decoded ahead of showing them: a clip shown before its strip has
  // decoded paints an empty frame where the character stood.
  const [decoded, setDecoded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const springRef = useRef<HTMLSpanElement | null>(null);
  const lidsRef = useRef<HTMLSpanElement | null>(null);
  const eyesRef = useRef<SVGSVGElement | null>(null);
  const clipRef = useRef<HTMLImageElement | null>(null);
  const sim = useRef({
    springs: REST,
    look: LOOK_REST,
    /** The last pointer over the window (client px), from the DOM or from
     *  notch.rs's feed; null once it left. */
    pointer: null as { x: number; y: number } | null,
    tracking: false,
    mid: { x: 0.5, y: 0.5 },
    socket: { rx: 0, ry: 0 },
    raf: 0,
    last: 0,
  });

  // Memoised: the player below is keyed on this object, and a fresh one per
  // render restarted the clip from frame 0 on every tick, poke or push.
  const now = useMemo(
    () => clipNow(run, resolveShipped, reduced, visible),
    [run, reduced, visible],
  );
  const clip: ClipSpec | null =
    now && decoded.has(now.spec.url) ? now.spec : null;
  // Waiting on a strip, the still is the clip's first frame; once a clip has
  // handed back, its last.
  const still = now && !clip ? stillBefore(b, now.name) : stillAfter(b, run);
  const pose = entering && still.enterPose ? still.enterPose : still.pose;
  const eyes = eyesFor(pose);
  const eyeMode: EyeMode = reaction ? REACTIONS[reaction].eyes : still.eyes;
  const mid = eyesMid(eyes);
  // Read by the running rAF, which outlives the render that started it.
  sim.current.socket = socketFor(eyes[0]);
  sim.current.mid = mid;

  // One rAF for every spring; it stops itself once all are at rest.
  const wake = (): void => {
    const s = sim.current;
    if (s.raf) return;
    s.last = performance.now();
    const tick = (now: number): void => {
      // Clamp a long frame so a stall does not skip the whole squish.
      const dt = Math.min(1 / 30, (now - s.last) / 1000);
      s.last = now;
      s.springs = stepAll(s.springs, SPRING_REST, dt);
      // The box is read per frame, not per event: the mascot moves while the
      // eyes find the pointer, and a pointer that has stopped sends no new
      // event to aim from.
      const box =
        s.tracking && s.pointer
          ? rootRef.current?.getBoundingClientRect()
          : undefined;
      const at =
        box && s.pointer
          ? pointerAim(s.pointer.x, s.pointer.y, box, s.mid)
          : { x: 0, y: 0 };
      // No eyes drawn (a clip carries its own): the look holds straight ahead.
      const aim = eyesRef.current ? lookOffset(at.x, at.y, s.socket) : null;
      s.look = lookStep(s.look, aim, dt);
      const { x, y, sx, sy, r } = s.springs;
      if (springRef.current) {
        springRef.current.style.transform = `translate(${x.x * 100}%, ${y.x * 100}%) rotate(${r.x}deg) scale(${sx.x}, ${sy.x})`;
      }
      if (eyesRef.current) {
        eyesRef.current.style.transform = `translate(${s.look.x.x * 100}%, ${s.look.y.x * 100}%)`;
      }
      const lookStill =
        Math.abs(s.look.x.x - (aim?.dx ?? 0)) < 1e-4 &&
        Math.abs(s.look.y.x - (aim?.dy ?? 0)) < 1e-4 &&
        Math.abs(s.look.x.v) + Math.abs(s.look.y.v) < 1e-3;
      if (settled(s.springs, SPRING_REST) && lookStill) {
        s.raf = 0;
        return;
      }
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const s = sim.current;
    return () => {
      // Zeroed too, or a remount (StrictMode does one) finds a stale id and
      // wake() never starts the loop again.
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
  }, []);

  // Entering a state: its kick and its enter pose. A clip carries its own
  // motion, so the kick — the procedural stand-in — waits on there being none.
  useEffect(() => {
    if (reduced) return;
    if (b.impulse && !now) {
      sim.current.springs = kick(sim.current.springs, b.impulse);
      wake();
    }
    if (!b.enterPose || !b.enterMs) return;
    setEntering(true);
    const id = window.setTimeout(() => setEntering(false), b.enterMs);
    return () => window.clearTimeout(id);
    // Keyed on the state alone: re-running on every render would re-kick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // Blink: a seeded Web Animations cycle on the lids — no timer, no rAF.
  const blinks = still.blink && !reduced && !reaction && !clip;
  useEffect(() => {
    const lids = lidsRef.current;
    if (!blinks || !lids || typeof lids.animate !== "function") return;
    const { keyframes, duration } = blinkKeyframes(BLINK_SEED);
    const anim = lids.animate(keyframes, { duration, iterations: Infinity });
    return () => anim.cancel();
  }, [blinks]);

  // Look-at input, one path for both feeds: the DOM pointer over this window,
  // and notch.rs's panel-local feed for a pointer over or near it while
  // another app is frontmost (decision 5), which notchDriver re-dispatches as
  // this same pointermove. Always listening — events only arrive while the
  // pointer is here — so a pointer seen before the peek opened is looked at
  // the moment tracking starts.
  useEffect(() => {
    const s = sim.current;
    const onMove = (e: PointerEvent): void => {
      s.pointer = { x: e.clientX, y: e.clientY };
      if (s.tracking) wake();
    };
    const onLeave = (): void => {
      s.pointer = null;
      if (s.tracking) wake();
    };
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  // Tracking on looks at the pointer, off looks ahead; no change, no frame.
  const tracks = b.track && !reduced;
  useEffect(() => {
    const s = sim.current;
    if (s.tracking === tracks) return;
    s.tracking = tracks;
    wake();
  }, [tracks]);

  // A clip handing back remounts the drawn eyes looking ahead: the look
  // starts there too, and eases to a pointer already parked rather than
  // jumping on its next move.
  useEffect(() => {
    if (clip) return;
    sim.current.look = LOOK_REST;
    if (sim.current.tracking) wake();
  }, [clip]);

  // Listening: the cap glow follows the mic level, read per frame from the
  // same ring buffer the waveform draws. Only while the glow is drawn, which
  // a clip stands it down from: no frames for nothing on screen.
  const listens =
    b.loop === "listen" && !reduced && !clip && levels !== undefined;
  useEffect(() => {
    const root = rootRef.current;
    if (!listens || !root || !levels) return;
    let frame = 0;
    const draw = (): void => {
      const ring = levels.read();
      root.style.setProperty(
        "--mascot-glow",
        String(glowFromLevel(ring[ring.length - 1])),
      );
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      root.style.removeProperty("--mascot-glow");
    };
  }, [listens, levels]);

  useEffect(() => {
    const onVisibility = (): void =>
      setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Collapsed idle and quiet for DOZE_AFTER_MS: it dozes off. One timeout,
  // only while idle, awake, on screen and with motion welcome.
  const dozes = dozeArmed(run, reduced, visible);
  useEffect(() => {
    if (!dozes) return;
    const id = window.setTimeout(() => setRun(dozeOff), DOZE_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [dozes]);

  // Decode the strips this run still has to play, the next one included (and
  // wake while dozing), so each appears whole on its first frame. One that
  // will not decode is let through: its <img> then fails, and onError moves
  // the run on.
  useEffect(() => {
    if (reduced || !visible) return;
    for (const name of clipsAhead(run)) {
      const spec = resolveShipped(name);
      if (!spec) continue;
      const img = new Image();
      img.src = spec.url;
      const ready = (): void =>
        setDecoded((d) => (d.has(spec.url) ? d : new Set(d).add(spec.url)));
      img.decode().then(ready, ready);
    }
  }, [run, reduced, visible]);

  // A clip plays its strip once (or loops), holds its last frame, then the
  // run moves on: the next clip, or the still that frame ends on. A layout
  // effect, so the strip is never painted at a stale offset.
  useLayoutEffect(() => {
    const img = clipRef.current;
    if (!clip || !now || !img || typeof img.animate !== "function") return;
    const anim = img.animate(
      [
        { transform: "translateX(0)" },
        {
          transform: `translateX(${(-(clip.frames - 1) / clip.frames) * 100}%)`,
        },
      ],
      {
        duration: (clip.frames / clip.fps) * 1000,
        easing: `steps(${clip.frames}, jump-none)`,
        iterations: clip.loop ? Infinity : 1,
        fill: "forwards",
      },
    );
    anim.onfinish = () => setRun((r) => (r === run ? clipEnded(r, now.index) : r));
    return () => anim.cancel();
  }, [clip, now, run]);

  useEffect(() => {
    if (!reaction) return;
    const id = window.setTimeout(
      () => setReaction(null),
      REACTIONS[reaction].ms,
    );
    return () => window.clearTimeout(id);
  }, [reaction]);

  const px = PLACEMENT_PX[placement];
  const glow = glowFor(pose);

  return (
    <span
      ref={rootRef}
      aria-hidden
      className="notch-mascot"
      data-placement={placement}
      // A clip carries its own motion; the CSS bob would float it on top.
      data-loop={clip ? undefined : b.loop}
      data-clip={now?.name}
      data-reaction={reaction ?? undefined}
      data-fx={still.fx ?? undefined}
      style={
        {
          "--mascot-lean": `${b.lean}deg`,
          "--mascot-glow-base": String(b.glow),
        } as CSSProperties
      }
      onClick={(e) => {
        // The driver's window-level click opens the capture; poking the
        // mascot must not.
        e.stopPropagation();
        const next = e.detail >= 3 ? "dizzy" : "poke";
        setReaction(next);
        if (!reduced) {
          sim.current.springs = kick(
            sim.current.springs,
            REACTIONS[next].impulse,
          );
          wake();
        }
      }}
    >
      <span ref={springRef} className="notch-mascot-spring">
        <span className="notch-mascot-body">
          {/* The still stays mounted (hidden) under a clip, loaded for the
              hand-off: mounted only then, it could paint an empty frame
              between the clip's last frame and the pose. */}
          <img
            className="notch-mascot-pose"
            src={layer(pose, 128)}
            srcSet={`${layer(pose, 64)} 64w, ${layer(pose, 128)} 128w`}
            sizes={`${px}px`}
            alt=""
            draggable={false}
            style={clip ? { visibility: "hidden" } : undefined}
          />
          {hasFx(pose) ? (
            <img
              className="notch-mascot-fx"
              src={layer(pose, 128, true)}
              srcSet={`${layer(pose, 64, true)} 64w, ${layer(pose, 128, true)} 128w`}
              sizes={`${px}px`}
              alt=""
              draggable={false}
              style={clip ? { visibility: "hidden" } : undefined}
            />
          ) : null}
          {clip && now ? (
            <span
              // A fresh element per clip: the next strip never shows at the
              // last one's final offset.
              key={now.index}
              className="notch-mascot-clip"
              style={clipBox(clip.pad)}
            >
              <img
                ref={clipRef}
                src={clip.url}
                alt=""
                draggable={false}
                style={{ width: `${clip.frames * 100}%` }}
                onError={() =>
                  setRun((r) => (r === run ? clipEnded(r, now.index) : r))
                }
              />
            </span>
          ) : null}
          {/* Pinned to the still pose's cap, so hidden over a clip (styles.css,
              .notch-mascot-clip ~ .notch-mascot-glow): the clip lights its
              own underside, and a pinned glow stayed behind as a smudge
              whenever the character hopped or swayed off it. Mounted
              throughout, so after a clip it fades back in, not pops. */}
          <span
            className="notch-mascot-glow"
            style={{
              left: `${(glow.cx - glow.w * 0.75) * 100}%`,
              top: `${(glow.cy - glow.h * 0.75) * 100}%`,
              width: `${glow.w * 150}%`,
              height: `${glow.h * 150}%`,
            }}
          />
          {clip ? null : (
            <span
              ref={lidsRef}
              className="notch-mascot-lids"
              // Lids close toward the eye line, not the box centre.
              style={{ transformOrigin: `${mid.x * 100}% ${mid.y * 100}%` }}
            >
              <svg
                ref={eyesRef}
                className="notch-mascot-eyes"
                viewBox="0 0 1 1"
                data-eyes={eyeMode}
              >
                {eyes.map((eye, i) => (
                  <Eye
                    key={i}
                    eye={eye}
                    mode={eyeMode}
                    side={i === 0 ? -1 : 1}
                  />
                ))}
              </svg>
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

/** A padded strip frame over the pose box, centred, at the pose's scale. */
function clipBox(pad: number): CSSProperties {
  const f = clipFrame(pad);
  return {
    left: `${f.x * 100}%`,
    top: `${f.y * 100}%`,
    width: `${f.size * 100}%`,
    height: `${f.size * 100}%`,
  };
}

function eyesMid(eyes: readonly EyeAnchor[]): { x: number; y: number } {
  return { x: (eyes[0].cx + eyes[1].cx) / 2, y: (eyes[0].cy + eyes[1].cy) / 2 };
}

/** One drawn eye. `side` is -1 for the left eye, 1 for the right. */
function Eye({
  eye,
  mode,
  side,
}: {
  eye: EyeAnchor;
  mode: EyeMode;
  side: -1 | 1;
}): JSX.Element {
  const { cx, cy, rx, ry } = eye;
  switch (mode) {
    case "open":
      return <ellipse cx={cx} cy={cy} rx={rx} ry={ry} />;
    case "wide":
      return <ellipse cx={cx} cy={cy} rx={rx * 1.15} ry={ry * 1.2} />;
    case "squint":
      // Annoyed: flattened, inner corners pulled down.
      return (
        <ellipse
          cx={cx}
          cy={cy + ry * 0.3}
          rx={rx * 1.25}
          ry={ry * 0.32}
          transform={`rotate(${side * -16} ${cx} ${cy})`}
        />
      );
    case "closed": {
      // The sheet's resting crescent, where it drew one.
      const a = eye.arc?.rx ?? rx * 1.5;
      const h = (eye.arc?.ry ?? ry * 0.4) * 1.4;
      return (
        <path
          className="notch-mascot-lid"
          d={`M ${cx - a} ${cy + ry * 0.35} Q ${cx} ${cy + ry * 0.35 + h * 2} ${cx + a} ${cy + ry * 0.35}`}
          strokeWidth={ry * 0.42}
        />
      );
    }
    case "spiral": {
      const r = ry * 1.05;
      let d = `M ${cx} ${cy}`;
      for (let t = 0.4; t <= Math.PI * 4; t += 0.4) {
        const k = (t / (Math.PI * 4)) * r;
        d += ` L ${cx + Math.cos(t * side) * k} ${cy + Math.sin(t * side) * k}`;
      }
      return (
        <path className="notch-mascot-spiral" d={d} strokeWidth={rx * 0.42} />
      );
    }
  }
}
