// MYCO's keyed clips and the app surfaces that play them, kept apart from
// MascotClip so the rules are testable without a DOM
// (spec: docs/specs/2026-10-02-mascot-motion-library.md). Each clip is three
// assets: an hvc1 .mov (WKWebView), a VP9 .webm (Chromium) and a poster that
// holds the pose the clip starts and ends on. Importing them yields URLs only;
// the media loads when a surface mounts its <video>.

import type { IngestStage } from "../stores/ingestStore";
import idleMov from "../assets/mascot/idle.mov";
import idleWebm from "../assets/mascot/idle.webm";
import idlePoster from "../assets/mascot/idle.poster.png";
import welcomeMov from "../assets/mascot/clips/welcome.mov";
import welcomeWebm from "../assets/mascot/clips/welcome.webm";
import welcomePoster from "../assets/mascot/clips/welcome.poster.png";
import notFoundMov from "../assets/mascot/clips/not-found.mov";
import notFoundWebm from "../assets/mascot/clips/not-found.webm";
import notFoundPoster from "../assets/mascot/clips/not-found.poster.png";
import worriedMov from "../assets/mascot/clips/worried.mov";
import worriedWebm from "../assets/mascot/clips/worried.webm";
import worriedPoster from "../assets/mascot/clips/worried.poster.png";
import celebrateMov from "../assets/mascot/clips/celebrate.mov";
import celebrateWebm from "../assets/mascot/clips/celebrate.webm";
import celebratePoster from "../assets/mascot/clips/celebrate.poster.png";
import absorbMov from "../assets/mascot/clips/absorb.mov";
import absorbWebm from "../assets/mascot/clips/absorb.webm";
import absorbPoster from "../assets/mascot/clips/absorb.poster.png";
import readLoopMov from "../assets/mascot/clips/read-loop.mov";
import readLoopWebm from "../assets/mascot/clips/read-loop.webm";
import readLoopPoster from "../assets/mascot/clips/read-loop.poster.png";
import thinkMov from "../assets/mascot/clips/think.mov";
import thinkWebm from "../assets/mascot/clips/think.webm";
import thinkPoster from "../assets/mascot/clips/think.poster.png";
import lookAroundMov from "../assets/mascot/clips/look-around.mov";
import lookAroundWebm from "../assets/mascot/clips/look-around.webm";
import lookAroundPoster from "../assets/mascot/clips/look-around.poster.png";

export interface ClipSpec {
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

// Adding a clip is one entry here plus its three assets, which
// scripts/mascot-app-clips.py encodes into assets/mascot/clips/. The krea clips are
// square full frames (the character fills ~64% of the box, the rest is room
// for hops and props), so they need no zoom; idle is a wide 16:9 frame.
export const CLIPS = {
  // The idle character spans ~71% of the frame height centered; 1.15 makes it
  // fill ~82% of the square crop.
  idle: { mov: idleMov, webm: idleWebm, poster: idlePoster, zoom: 1.15 },
  welcome: { mov: welcomeMov, webm: welcomeWebm, poster: welcomePoster, zoom: 1, loop: false },
  "not-found": { mov: notFoundMov, webm: notFoundWebm, poster: notFoundPoster, zoom: 1, loop: false },
  worried: { mov: worriedMov, webm: worriedWebm, poster: worriedPoster, zoom: 1, loop: false },
  celebrate: { mov: celebrateMov, webm: celebrateWebm, poster: celebratePoster, zoom: 1, loop: false },
  absorb: { mov: absorbMov, webm: absorbWebm, poster: absorbPoster, zoom: 1, loop: false },
  "read-loop": { mov: readLoopMov, webm: readLoopWebm, poster: readLoopPoster, zoom: 1 },
  think: { mov: thinkMov, webm: thinkWebm, poster: thinkPoster, zoom: 1 },
  "look-around": { mov: lookAroundMov, webm: lookAroundWebm, poster: lookAroundPoster, zoom: 1 },
} as const satisfies Record<string, ClipSpec>;
export type MascotClipKey = keyof typeof CLIPS;

/** Each surface's clip and its box in CSS px. scripts/mascot-app-clips.py
 *  encodes a clip at twice its largest box; the test holds the two together. */
export const SURFACE_CLIPS = {
  wizard: { clip: "welcome", size: 96 },
  about: { clip: "welcome", size: 128 },
  abstain: { clip: "not-found", size: 112 },
  spotlightAbstain: { clip: "not-found", size: 56 },
  crash: { clip: "worried", size: 112 },
  ingestReceived: { clip: "absorb", size: 96 },
  ingestRunning: { clip: "read-loop", size: 96 },
  ingestDone: { clip: "celebrate", size: 96 },
  studyDone: { clip: "celebrate", size: 96 },
  askPending: { clip: "think", size: 96 },
  askEmpty: { clip: "look-around", size: 144 },
} as const satisfies Record<string, { clip: MascotClipKey; size: number }>;

/** The clips the Ingest hero swaps between in its one slot. */
export const INGEST_CLIPS = ["absorb", "read-loop", "celebrate"] as const;
type IngestClip = (typeof INGEST_CLIPS)[number];

/** Starts loading `keys`' stills; hold on to the images while they may show.
 *  A still first loaded as its slot shows it paints nothing until it lands,
 *  and swapping a slot's still keeps painting the previous pose until the new
 *  one lands. On the Ingest hero that was a frame or two of blank as absorb
 *  started and of absorb's first pose before celebrate. A still loaded ahead
 *  paints at once. */
export function preloadStills(keys: readonly MascotClipKey[]): HTMLImageElement[] {
  return keys.map((k) => {
    const img = new Image();
    img.src = CLIPS[k].poster;
    return img;
  });
}

/** The Ingest hero's clip for a stage. A received source is absorbed once,
 *  then read while the run works; a finished run celebrates. `absorbing` is
 *  that one-shot still on screen: it finishes into the next working stage,
 *  the plan gate or the finish (it ends on the success pose celebrate starts
 *  on), so a fast judge never cuts it mid-gesture. The gate keeps absorb
 *  once it is over, as its still (ingestHeld): the attention pose, review
 *  needed. Every other stage keeps the still motion (null): after a refusal
 *  or a cancel nothing is happening. */
export function ingestClip(stage: IngestStage, absorbing: boolean): IngestClip | null {
  const working = stage === "writing-raw" || stage === "claude" || stage === "indexing";
  if (stage === "plan-gate") return "absorb";
  if (absorbing && (working || stage === "done")) return "absorb";
  if (working) return "read-loop";
  if (stage === "done") return "celebrate";
  return null;
}

/** Whether the absorb is on after the stage moved from `prev` to `stage`:
 *  a run being received starts it; it carries into the stages that have a
 *  clip, and stops where none does (a refusal, a cancel, an error).
 *  Its own end is the caller's onEnded. */
export function nextAbsorbing(prev: IngestStage, stage: IngestStage, absorbing: boolean): boolean {
  if (stage === "writing-raw") return prev === "writing-raw" ? absorbing : true;
  return absorbing && ingestClip(stage, false) !== null;
}

/** Whether the Ingest hero shows `clip`'s still instead of playing it.
 *  absorb outside a running absorb is the plan gate's still. celebrate marks
 *  the moment a run finishes, and the store keeps that run at "done" until
 *  the next one starts, so a page that mounted on a run the user had already
 *  seen finished holds the pose instead of hopping again. `atMount` is read
 *  once, as the page mounts and before the visit marks a run that finished
 *  while the user was away as seen. */
export function ingestHeld(
  clip: MascotClipKey | null,
  s: {
    absorbing: boolean;
    atMount: { stage: IngestStage; seen: boolean; runId: string | null };
    runId: string | null;
  },
): boolean {
  if (clip === "absorb") return !s.absorbing;
  if (clip !== "celebrate") return false;
  return s.atMount.stage === "done" && s.atMount.seen && s.atMount.runId === s.runId;
}

/** What a clip slot shows. The mascot switched off shows the static mark;
 *  reduced motion, a failed or missing clip, and a finished one-shot all show
 *  the still pose; only otherwise does the video play. */
export function clipView(s: {
  mascotEnabled: boolean;
  reduced: boolean;
  failed: boolean;
  ended: boolean;
}): "mark" | "still" | "video" {
  if (!s.mascotEnabled) return "mark";
  return s.reduced || s.failed || s.ended ? "still" : "video";
}

/** A callback ref for a clip's <video>. A hidden window plays nothing and an
 *  off-screen clip pauses; both resume where they left off, so a one-shot
 *  still ends on its own pose. Bound per element, as it mounts: an effect
 *  keyed on props ran once before a later <video> existed (the mascot
 *  switched back on), and that clip then decoded in a hidden window.
 *  `onDetach` runs as a video goes, so the next one starts behind its poster.
 *  A rejected play() fails the clip; a pause interrupting it does not. */
export function playbackRef(
  onFail: () => void,
  onDetach: () => void,
): (v: HTMLVideoElement | null) => void {
  let unbind: (() => void) | null = null;
  return (v) => {
    unbind?.();
    unbind = null;
    if (!v) {
      onDetach();
      return;
    }
    let bound = true;
    let onScreen = true;
    const apply = (): void => {
      if (!onScreen || document.hidden) {
        v.pause();
        return;
      }
      const attempt = v.play();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch((e: unknown) => {
          if (bound && (e as { name?: string } | null)?.name !== "AbortError") onFail();
        });
      }
    };
    apply();
    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            onScreen = entry.isIntersecting;
            apply();
          });
    io?.observe(v);
    document.addEventListener("visibilitychange", apply);
    unbind = () => {
      bound = false;
      io?.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  };
}

/** The crash screen's MYCO: the worried clip over its still, or the still
 *  alone where a clip may not play (reduced motion, the mascot off, a hidden
 *  window). The still stays even with the mascot off: it is what that screen
 *  always showed, and it is a plain <img> that cannot fail. */
export function crashMascot(s: {
  mascotEnabled: boolean;
  reduced: boolean;
  hidden: boolean;
  hevc: boolean;
}): { poster: string; src: string | null } {
  const c = CLIPS[SURFACE_CLIPS.crash.clip];
  const plays =
    !s.hidden &&
    clipView({ mascotEnabled: s.mascotEnabled, reduced: s.reduced, failed: false, ended: false }) ===
      "video";
  return { poster: c.poster, src: plays ? (s.hevc ? c.mov : c.webm) : null };
}

/** Alpha video needs a different codec per engine: the Tauri shell is
 *  WKWebView → HEVC+alpha (hvc1 .mov); a Chromium dev browser → VP9 alpha
 *  WebM. The source is picked by ENGINE SNIFF rather than <source> fallback on
 *  purpose — Chromium can hardware-decode hvc1 but WITHOUT its alpha layer,
 *  so it would "successfully" play the mov with the keyed-out backdrop painted
 *  back in.
 *
 *  The Tauri shell is WKWebView on macOS — detect the runtime directly (its
 *  UA may omit the "Safari" token, which mis-routed the shell to the VP9 webm;
 *  WKWebView decodes VP9 WITHOUT alpha, painting an opaque black box). Real
 *  Safari browsers carry no Chromium token in the UA. A Chromium token wins
 *  over the Tauri global: the dev mock (?mock=1) installs that global in a
 *  Chromium browser, where the .mov has no stream to play and every clip
 *  fell back to its poster. */
export function wantsHevc(): boolean {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/chrome|chromium|crios|edg|android/i.test(ua)) return false;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return true;
  return /safari/i.test(ua);
}
