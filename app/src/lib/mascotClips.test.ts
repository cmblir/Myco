// The app-surface clips (docs/specs/2026-10-02-mascot-motion-library.md):
// which surface plays which clip, what each clip does when it cannot play,
// and what the shipped files cost.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIPS,
  INGEST_CLIPS,
  SURFACE_CLIPS,
  clipView,
  crashMascot,
  ingestClip,
  ingestHeld,
  nextAbsorbing,
  playbackRef,
  preloadStills,
  wantsHevc,
} from "./mascotClips";
import type { ClipSpec } from "./mascotClips";

const DIR = new URL("../assets/mascot/clips/", import.meta.url);
const SPIN_DIR = new URL("../assets/mascot/spin/", import.meta.url);

describe("SURFACE_CLIPS", () => {
  it("gives each app surface the library's clip", () => {
    const clipOf = Object.fromEntries(
      Object.entries(SURFACE_CLIPS).map(([surface, s]) => [surface, s.clip]),
    );
    expect(clipOf).toEqual({
      wizard: "welcome",
      about: "welcome",
      abstain: "not-found",
      spotlightAbstain: "not-found",
      crash: "worried",
      ingestReceived: "absorb",
      ingestRunning: "read-loop",
      ingestDone: "celebrate",
      studyDone: "celebrate",
      askPending: "think",
      askEmpty: "look-around",
    });
  });

  it("loops only ongoing work and ambient idle; a reaction plays once", () => {
    const loops = Object.fromEntries(
      Object.entries(CLIPS).map(([name, c]: [string, ClipSpec]) => [name, c.loop ?? true]),
    );
    expect(loops).toEqual({
      idle: true,
      welcome: false,
      "not-found": false,
      worried: false,
      celebrate: false,
      absorb: false,
      "read-loop": true,
      think: true,
      "look-around": true,
    });
  });
});

describe("ingestClip", () => {
  it("absorbs a received source, then reads while the run works", () => {
    expect(ingestClip("writing-raw", true)).toBe("absorb");
    expect(ingestClip("writing-raw", false)).toBe("read-loop");
    expect(ingestClip("claude", false)).toBe("read-loop");
    expect(ingestClip("indexing", false)).toBe("read-loop");
  });

  it("lets a running absorb finish into the next working stage or the finish", () => {
    // absorb ends on the success pose celebrate starts on: no cut mid-gesture.
    expect(ingestClip("claude", true)).toBe("absorb");
    expect(ingestClip("done", true)).toBe("absorb");
    expect(ingestClip("done", false)).toBe("celebrate");
  });

  // The default run reaches the gate ~0.4 s after the absorb starts. Cutting
  // it there (about frame 10) to MycoMotion's idle render read as a flicker,
  // then a jump to another-looking mushroom 12 px away.
  it("lets a running absorb finish at the plan gate, which then holds its attention pose", () => {
    expect(ingestClip("plan-gate", true)).toBe("absorb");
    expect(ingestClip("plan-gate", false)).toBe("absorb");
  });

  it("leaves every other stage to the still motion", () => {
    for (const stage of ["idle", "cancelled", "refused", "error"] as const) {
      expect(ingestClip(stage, true)).toBeNull();
      expect(ingestClip(stage, false)).toBeNull();
    }
  });

  it("only ever picks one of INGEST_CLIPS, and picks each of them", () => {
    const stages = [
      "idle",
      "writing-raw",
      "plan-gate",
      "claude",
      "indexing",
      "done",
      "cancelled",
      "refused",
      "error",
    ] as const;
    const picked = new Set(stages.flatMap((s) => [ingestClip(s, true), ingestClip(s, false)]));
    picked.delete(null);
    expect([...picked].sort()).toEqual([...INGEST_CLIPS].sort());
  });
});

// The Ingest hero swaps clips in one slot. A still the slot had not loaded
// yet painted nothing as absorb started (two blank frames on every run of a
// CDP screencast), and swapping the still's src painted absorb's first pose
// between absorb's end and celebrate. Loaded ahead, neither happened.
describe("preloadStills", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts loading each clip's still and hands the images back to keep", () => {
    vi.stubGlobal(
      "Image",
      class {
        src = "";
      },
    );
    const stills = preloadStills(INGEST_CLIPS);
    expect(stills.map((i) => i.src)).toEqual(INGEST_CLIPS.map((k) => CLIPS[k].poster));
  });
});

describe("nextAbsorbing", () => {
  it("starts the absorb when a run is received, and keeps it through that stage", () => {
    expect(nextAbsorbing("idle", "writing-raw", false)).toBe(true);
    expect(nextAbsorbing("done", "writing-raw", false)).toBe(true);
    expect(nextAbsorbing("writing-raw", "writing-raw", false)).toBe(false);
  });

  it("carries a running absorb into the stages that follow, not into one without a clip", () => {
    expect(nextAbsorbing("writing-raw", "plan-gate", true)).toBe(true);
    expect(nextAbsorbing("plan-gate", "claude", true)).toBe(true);
    expect(nextAbsorbing("writing-raw", "claude", true)).toBe(true);
    expect(nextAbsorbing("writing-raw", "done", true)).toBe(true);
    for (const stage of ["refused", "cancelled", "error", "idle"] as const) {
      expect(nextAbsorbing("writing-raw", stage, true)).toBe(false);
    }
  });

  it("never starts an absorb past the received stage", () => {
    expect(nextAbsorbing("plan-gate", "claude", false)).toBe(false);
    expect(nextAbsorbing("indexing", "done", false)).toBe(false);
  });
});

describe("ingestHeld", () => {
  // The ingest store keeps a finished run at "done" until the next one, so
  // every visit mounted a fresh celebrate and MYCO hopped again for a run
  // long over. What the page saw when it mounted decides.
  const done = { stage: "done", seen: true, runId: "r1" } as const;
  const held = (clip: "celebrate" | "absorb", s: Partial<Parameters<typeof ingestHeld>[1]>): boolean =>
    ingestHeld(clip, { absorbing: false, atMount: done, runId: "r1", ...s });

  it("holds celebrate for a run already seen finished when the page mounted", () => {
    expect(held("celebrate", {})).toBe(true);
  });

  it("celebrates a run that finishes while the page is open, or finished while it was away", () => {
    expect(held("celebrate", { atMount: { stage: "claude", seen: true, runId: "r1" } })).toBe(false);
    // Not yet seen: the user's first look at it still gets the hop.
    expect(held("celebrate", { atMount: { ...done, seen: false } })).toBe(false);
  });

  it("celebrates the next run started from a page that mounted on a finished one", () => {
    expect(held("celebrate", { runId: "r2" })).toBe(false);
  });

  // absorb starts on the attention pose, the README's "review or approval
  // needed", which is what the plan gate asks for.
  it("holds absorb's still at the plan gate once the absorb is over, and plays it until then", () => {
    expect(held("absorb", { absorbing: false })).toBe(true);
    expect(held("absorb", { absorbing: true })).toBe(false);
  });
});

describe("clipView", () => {
  const on = { mascotEnabled: true, reduced: false, failed: false, ended: false };

  it("plays the clip when nothing stops it", () => {
    expect(clipView(on)).toBe("video");
  });

  it("shows the still pose under reduced motion", () => {
    expect(clipView({ ...on, reduced: true })).toBe("still");
  });

  it("falls back to the still when the clip fails or is missing", () => {
    expect(clipView({ ...on, failed: true })).toBe("still");
  });

  it("holds the still once a one-shot has ended", () => {
    expect(clipView({ ...on, ended: true })).toBe("still");
  });

  it("shows the static mark when the mascot is off, whatever else holds", () => {
    expect(clipView({ ...on, mascotEnabled: false })).toBe("mark");
    expect(clipView({ ...on, mascotEnabled: false, reduced: true, failed: true })).toBe("mark");
  });
});

describe("crashMascot", () => {
  const ok = { mascotEnabled: true, reduced: false, hidden: false, hevc: false };
  const worried = CLIPS.worried;

  it("plays the worried clip in the engine's codec over its still", () => {
    expect(crashMascot(ok)).toEqual({ poster: worried.poster, src: worried.webm });
    expect(crashMascot({ ...ok, hevc: true })).toEqual({ poster: worried.poster, src: worried.mov });
  });

  it("keeps the still under reduced motion, with the mascot off and in a hidden window", () => {
    for (const s of [{ reduced: true }, { mascotEnabled: false }, { hidden: true }]) {
      expect(crashMascot({ ...ok, ...s })).toEqual({ poster: worried.poster, src: null });
    }
  });
});

describe("playbackRef", () => {
  interface Fake {
    paused: boolean;
    calls: number;
    play: () => Promise<void>;
    pause: () => void;
  }
  const video = (play: () => Promise<void> = () => Promise.resolve()): Fake => {
    const v: Fake = {
      paused: true,
      calls: 0,
      play: () => {
        v.calls++;
        v.paused = false;
        return play();
      },
      pause: () => {
        v.calls++;
        v.paused = true;
      },
    };
    return v;
  };
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const seen = new Map<unknown, (entries: { isIntersecting: boolean }[]) => void>();
  const setHidden = (hidden: boolean): void => {
    doc.hidden = hidden;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  const bind = (ref: (v: HTMLVideoElement | null) => void, v: Fake | null): void =>
    ref(v as unknown as HTMLVideoElement | null);
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.hidden = false;
    seen.clear();
  });
  const stub = (): void => {
    vi.stubGlobal("document", doc);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private cb: (entries: { isIntersecting: boolean }[]) => void) {}
        observe(el: unknown): void {
          seen.set(el, this.cb);
        }
        disconnect(): void {
          for (const [el, cb] of seen) if (cb === this.cb) seen.delete(el);
        }
      },
    );
  };

  // The mascot switched off renders the mark (no <video>); switched back on,
  // a new <video> mounts. The first binding ran before it existed and never
  // ran again, so that clip kept decoding in a hidden window.
  it("binds a video that mounts after the slot first rendered without one", () => {
    stub();
    const onDetach = vi.fn();
    const ref = playbackRef(vi.fn(), onDetach);
    const first = video();
    bind(ref, first);
    expect(first.paused).toBe(false);
    bind(ref, null); // the mark
    expect(onDetach).toHaveBeenCalledOnce();
    const calls = first.calls;
    setHidden(true);
    setHidden(false);
    expect(first.calls).toBe(calls); // unbound: the window no longer drives it
    expect(seen.has(first)).toBe(false);

    const next = video();
    bind(ref, next);
    setHidden(true);
    expect(next.paused).toBe(true);
    setHidden(false);
    expect(next.paused).toBe(false);
    seen.get(next)?.([{ isIntersecting: false }]);
    expect(next.paused).toBe(true);
  });

  it("starts a video that mounts in a hidden window paused", () => {
    stub();
    doc.hidden = true;
    const v = video();
    bind(playbackRef(vi.fn(), vi.fn()), v);
    expect(v.paused).toBe(true);
  });

  it("fails the clip on a rejected play(), not on a pause interrupting it", async () => {
    stub();
    const onFail = vi.fn();
    const abort = Object.assign(new Error("interrupted"), { name: "AbortError" });
    bind(playbackRef(onFail, vi.fn()), video(() => Promise.reject(abort)));
    await Promise.resolve();
    expect(onFail).not.toHaveBeenCalled();
    bind(playbackRef(onFail, vi.fn()), video(() => Promise.reject(new Error("decode"))));
    await new Promise((r) => setTimeout(r, 0));
    expect(onFail).toHaveBeenCalledOnce();
  });
});

describe("wantsHevc", () => {
  const WKWEBVIEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const SAFARI = `${WKWEBVIEW} Version/18.0 Safari/605.1.15`;
  const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36";
  const engine = (ua: string, tauri: boolean): void => {
    vi.stubGlobal("navigator", { userAgent: ua });
    vi.stubGlobal("window", tauri ? { __TAURI_INTERNALS__: {} } : {});
  };
  afterEach(() => vi.unstubAllGlobals());

  it("picks the hvc1 .mov for the Tauri shell (WKWebView) and for Safari", () => {
    engine(WKWEBVIEW, true);
    expect(wantsHevc()).toBe(true);
    engine(SAFARI, false);
    expect(wantsHevc()).toBe(true);
  });

  it("picks the VP9 .webm for Chromium, even where the dev mock installs the Tauri global", () => {
    engine(CHROME, false);
    expect(wantsHevc()).toBe(false);
    engine(CHROME, true);
    expect(wantsHevc()).toBe(false);
  });
});

describe("shipped clip files", () => {
  const files = readdirSync(DIR).filter((f) => !f.startsWith("."));
  const used = new Set(Object.values(SURFACE_CLIPS).map((s) => s.clip));

  it("ships exactly the clips a surface uses: an hvc1 .mov, a VP9 .webm and a poster each", () => {
    const expected = [...used].flatMap((c) => [`${c}.mov`, `${c}.webm`, `${c}.poster.png`]);
    expect(files.sort()).toEqual(expected.sort());
  });

  // The Settings card's spin turntables (spec 2026-10-04-myco-spin.md) share it.
  it("stays within the 4 MB app-video budget, spin turntables included", () => {
    const sizeOf = (dir: URL): number =>
      readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .reduce((sum, f) => sum + statSync(new URL(f, dir)).size, 0);
    const spin = sizeOf(SPIN_DIR);
    expect(spin).toBeGreaterThan(0);
    expect(sizeOf(DIR) + spin).toBeLessThanOrEqual(4_000_000);
  });

  it("encodes each clip at twice the largest box a surface draws it in", () => {
    for (const clip of used) {
      const box = Math.max(
        ...Object.values(SURFACE_CLIPS)
          .filter((s) => s.clip === clip)
          .map((s) => s.size),
      );
      // PNG IHDR: the width is the big-endian u32 at byte 16.
      const width = readFileSync(new URL(`${clip}.poster.png`, DIR)).readUInt32BE(16);
      expect([clip, width]).toEqual([clip, box * 2]);
    }
  });
});
