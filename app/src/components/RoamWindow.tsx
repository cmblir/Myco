// The roam window's whole UI (index.html?window=roam): myco out of the notch
// while work runs (spec: docs/specs/2026-10-02-mascot-roam.md). Like the
// notch, a secondary webview where App never mounts. While roam.rs has it out
// (`place`), it steps lib/roamMotion once per frame over the notch's cue and
// draws the RoamFrame that comes out; once myco has gone back in it asks
// roam.rs to order the window out. Hidden, nothing runs. Viewable without a
// shell: `?window=roam&roamMock=1` runs the same motion over a scripted job
// on a painted screen (lib/roamPreview).
// Decorative (aria-hidden): the notch's text stays the source of status.

import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import NotchMascot, {
  prefersReducedMotion,
  resolveShipped,
  subscribeReducedMotion,
} from "./NotchMascot";
import { ipc } from "../lib/ipc";
import type { RoamPlace } from "../lib/ipc";
import { ROAM_MYCO_PX } from "../lib/roam";
import type { RoamCue, RoamFrame } from "../lib/roam";
import { clipMs, roamFrame, roamStart, roamTick } from "../lib/roamMotion";
import type { Pt } from "../lib/roamPlan";
import {
  PREVIEW_SEED,
  ROAM_MOCK_BAR,
  ROAM_MOCK_NOTCH_W,
  mockPlace,
  previewCue,
  previewWalk,
  readRoamMock,
  roamPreviewFrames,
} from "../lib/roamPreview";
import type { RoamMock } from "../lib/roamPreview";

/** The motion library's enter clip, once its pair is dropped into
 *  assets/mascot/motion/: the way home then runs as long as it does. */
const ENTER_CLIP = resolveShipped("enter");
const ENTER_CLIP_MS = clipMs(ENTER_CLIP);
/** Its hop clip, likewise: each hop between stops then runs one cycle of it. */
const HOP_CLIP = resolveShipped("hop");
const HOP_CLIP_MS = clipMs(HOP_CLIP);

/** The live preview starts over this long after myco went back in. */
const PREVIEW_RESTART_MS = 1500;

/** Its own props never change while it roams, so the stage re-rendering per
 *  frame leaves the mascot (its clip, its blink) alone. */
const Mascot = memo(NotchMascot);

/** The bubble's width at 12.5 px mono: about 8 px a character, plus its
 *  padding and gap. */
const bubbleRoom = (text: string): number => text.length * 8 + 16;

/** One myco at `frame`, and the step count beside it while the job has one:
 *  on its right, or on its left where the right would run off the window
 *  (`width`, the roam window's). */
export function RoamStage({ frame, width }: { frame: RoamFrame; width: number }): JSX.Element {
  const { x, y, groundY = y, sx, sy, lean = 0, lag = 0, progress } = frame;
  const top = y - ROAM_MYCO_PX;
  const lift = Math.max(0, groundY - y);
  const rise = Math.min(1, lift / 60);
  const shadowOpacity = frame.act === "enter"
    ? Math.max(0, Math.min(1, y / Math.max(1, groundY)))
    : Math.max(0, 1 - lift / 160);
  const count = progress ? `${progress.done}/${progress.total}` : null;
  const left = count !== null && x + ROAM_MYCO_PX / 2 + bubbleRoom(count) > width;
  return (
    <div className="roam" aria-hidden>
      <div
        className="roam-shadow"
        style={{
          transform: `translate(${x}px, ${groundY - 3}px) translate(-50%, -50%) scale(${1 - rise * 0.4}, ${1 - rise * 0.2})`,
          opacity: shadowOpacity,
        }}
      />
      <div
        className="roam-myco"
        style={{
          transform: `translate(${x - ROAM_MYCO_PX / 2}px, ${top}px) rotate(${lean}deg) skewX(${lag}deg) scale(${sx}, ${sy})`,
        }}
      >
        <Mascot kind={frame.act} placement="roam" />
      </div>
      {count !== null ? (
        <span
          className={left ? "roam-bubble roam-bubble-left" : "roam-bubble"}
          style={{
            transform: left
              ? `translate(${x - ROAM_MYCO_PX / 2}px, ${top}px) translateX(-100%)`
              : `translate(${x + ROAM_MYCO_PX / 2}px, ${top}px)`,
          }}
        >
          {count}
        </span>
      ) : null}
    </div>
  );
}

/** Before the notch's cue has arrived: reading, with no steps. */
const WAITING: RoamCue = { job: "read", progress: null, outcome: null };

function sameFrame(a: RoamFrame, b: RoamFrame): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.groundY === b.groundY &&
    a.act === b.act &&
    a.sx === b.sx &&
    a.sy === b.sy &&
    a.lean === b.lean &&
    a.lag === b.lag &&
    a.progress === b.progress
  );
}

/** The last pointer over this window, `dy` px above the roam window's own
 *  top (the preview's painted menu bar); null once it left. roamFeed
 *  re-dispatches roam.rs's feed as these same pointermoves. */
function usePointer(dy: number): () => Pt | null {
  const at = useRef<Pt | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      at.current = { x: e.clientX, y: e.clientY - dy };
    };
    const onLeave = (): void => {
      at.current = null;
    };
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [dy]);
  return () => at.current;
}

/** One roam, a rAF per frame from the pop to the way back in: `cue` and
 *  `pointer` are read each frame, `onGone` runs once myco is back in the
 *  notch. */
function useRoamWalk(
  place: RoamPlace,
  seed: number,
  cue: (ms: number) => RoamCue,
  pointer: () => Pt | null,
  onGone: () => void,
): RoamFrame {
  const [frame, setFrame] = useState(() =>
    roamFrame(roamStart(place, seed, ENTER_CLIP_MS, HOP_CLIP_MS), cue(0)),
  );
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion);
  const read = useRef({ cue, pointer, onGone, reduced });
  read.current = { cue, pointer, onGone, reduced };
  useEffect(() => {
    let sim = roamStart(place, seed, ENTER_CLIP_MS, HOP_CLIP_MS);
    let raf = 0;
    let last = performance.now();
    const began = last;
    let finished = false;
    const tick = (now: number): void => {
      const { cue, pointer, onGone, reduced } = read.current;
      const c = cue(now - began);
      sim = roamTick(sim, now - last, { place, cue: c, pointer: pointer(), reduced });
      last = now;
      const next = roamFrame(sim, c);
      setFrame((prev) => (sameFrame(prev, next) ? prev : next));
      if (sim.phase === "gone") {
        finished = true;
        onGone();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    const visibilityChanged = (): void => {
      cancelAnimationFrame(raf);
      if (!finished && document.visibilityState !== "hidden") {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [place, seed]);
  return frame;
}

function RoamLive({ place, cue }: { place: RoamPlace; cue: RoamCue | null }): JSX.Element {
  // A fresh walk per roam: roam.rs sends a new place each time it goes out.
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const pointer = usePointer(0);
  const frame = useRoamWalk(
    place,
    seed,
    () => cue ?? WAITING,
    pointer,
    () =>
      void ipc.roamHide().catch((err: unknown) => console.error("roam: hide failed:", err)),
  );
  return <RoamStage frame={frame} width={place.width} />;
}

/** The painted screen around the preview, with an undecorated menu bar. */
export function MockDesk({
  children,
}: {
  children?: JSX.Element;
}): JSX.Element {
  return (
    <>
      <div className="roam-mock-desk">
        <div className="roam-mock-bar" style={{ height: ROAM_MOCK_BAR }}>
          <div className="roam-mock-cutout" style={{ width: ROAM_MOCK_NOTCH_W }} />
        </div>
      </div>
      <div className="roam-mock-window" style={{ top: ROAM_MOCK_BAR }}>
        {children}
      </div>
    </>
  );
}

/** The live preview: the scripted job over the real motion, the mouse as the
 *  pointer, starting over a moment after each way home. */
function PreviewWalk({
  place,
  fail,
  wander,
}: {
  place: RoamPlace;
  fail: boolean;
  wander: boolean;
}): JSX.Element {
  const [round, setRound] = useState(0);
  const [gone, setGone] = useState(false);
  const pointer = usePointer(ROAM_MOCK_BAR);
  const frame = useRoamWalk(
    place,
    PREVIEW_SEED + round,
    (ms) => previewCue(ms, fail, wander),
    pointer,
    () => setGone(true),
  );
  useEffect(() => {
    if (!gone) return;
    const id = window.setTimeout(() => {
      setGone(false);
      setRound((r) => r + 1);
    }, PREVIEW_RESTART_MS);
    return () => window.clearTimeout(id);
  }, [gone]);
  return (
    <MockDesk>
      {gone ? undefined : <RoamStage frame={frame} width={place.width} />}
    </MockDesk>
  );
}

function RoamPreview({ mock }: { mock: RoamMock }): JSX.Element {
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion);
  const place = mockPlace(window.innerWidth, window.innerHeight);

  // Reduced motion: no roaming character or resting menu-bar attachment.
  if (reduced) {
    return <MockDesk />;
  }
  if (mock.pinned !== null) {
    const frame = roamPreviewFrames(place)[mock.pinned];
    return (
      <MockDesk>
        <RoamStage frame={frame} width={place.width} />
      </MockDesk>
    );
  }
  if (mock.at !== null) {
    const { sim, frame } = previewWalk(place, mock.at, mock.fail, mock.wander);
    const back = sim.phase === "gone";
    return (
      <MockDesk>
        {back ? undefined : <RoamStage frame={frame} width={place.width} />}
      </MockDesk>
    );
  }
  return <PreviewWalk place={place} fail={mock.fail} wander={mock.wander} />;
}

export default function RoamWindow({
  place,
  cue = null,
}: {
  /** roam.rs's place while myco is out; null draws nothing. */
  place: RoamPlace | null;
  /** The notch's cue for the work it is out for (lib/roamFeed). */
  cue?: RoamCue | null;
}): JSX.Element | null {
  const [mock] = useState(() => readRoamMock(location.search));

  useEffect(() => {
    // The window itself is see-through; only myco paints.
    document.documentElement.classList.add("roam-window");
    // Fetched ahead, so the clip starts as myco lands, not a decode later.
    if (ENTER_CLIP) new Image().src = ENTER_CLIP.url;
    if (HOP_CLIP) new Image().src = HOP_CLIP.url;
  }, []);

  if (mock.on) return <RoamPreview mock={mock} />;
  // Null between roams, so every roam mounts its own walk from the pop.
  return place ? <RoamLive place={place} cue={cue} /> : null;
}
