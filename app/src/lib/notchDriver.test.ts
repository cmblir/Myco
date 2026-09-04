// The notch driver's pure half: the reducer that walks the design sheet's
// states from real events, and the small label/parse helpers around it. The
// hook (Tauri subscriptions, timers, window sizing) is untestable here —
// this repo's vitest is node-only — which is exactly why the reducer exists
// as a function.

import { describe, expect, it } from "vitest";
import {
  ACCEPTED_DWELL_MS,
  NOTCH_IDLE,
  REJECTED_DWELL_MS,
  batchLabel,
  dragLabel,
  dwellMsFor,
  extLabel,
  reduceNotch,
  runningPercent,
  voiceHotkeyAction,
} from "./notchDriver";
import type { NotchDriverState, NotchEvent } from "./notchDriver";
import { today } from "./taskLine";
import { EMPTY_CAPTION } from "./liveCaption";
import { createHotkeyGate } from "./voiceCapture";
import {
  CANCELLED_DWELL_MS,
  DONE_DWELL_MS,
  describeNotch,
} from "../components/NotchPanel";
import { STRINGS } from "./i18n";

const T0 = 1_756_000_000_000;

function walk(
  from: NotchDriverState,
  events: (NotchEvent & { at?: number })[],
): NotchDriverState {
  return events.reduce(
    (s, { at, ...event }) => reduceNotch(s, event as NotchEvent, at ?? T0),
    from,
  );
}

describe("hover peek", () => {
  it("hover unfolds idle into peek and folds back on leave", () => {
    const t0 = 1_000;
    let st = reduceNotch(NOTCH_IDLE, { type: "hoverEnter" }, t0);
    expect(st.panel.kind).toBe("peek");
    st = reduceNotch(st, { type: "hoverLeave" }, t0 + 100);
    expect(st.panel.kind).toBe("idle");
  });

  it("hover never interrupts capture, recording, or a running HUD", () => {
    for (const panel of [
      { kind: "capture", text: "x" },
      { kind: "recording", startedAt: 1 },
      { kind: "running", label: "l", percent: null, detail: "", startedAt: 1 },
    ] as const) {
      const st = reduceNotch(
        { panel, runningSince: null } as never,
        { type: "hoverEnter" },
        5_000,
      );
      expect(st.panel.kind).toBe(panel.kind);
    }
  });

  it("a click from the peek opens capture", () => {
    let st = reduceNotch(NOTCH_IDLE, { type: "hoverEnter" }, 1);
    st = reduceNotch(st, { type: "captureOpen" }, 2);
    expect(st.panel.kind).toBe("capture");
  });

  it("a drag entering the peek still shows the drop zone", () => {
    let st = reduceNotch(NOTCH_IDLE, { type: "hoverEnter" }, 1);
    st = reduceNotch(st, { type: "dragEnter", paths: ["/a/b.pdf"] }, 2);
    expect(st.panel.kind).toBe("dragging");
  });
});

describe("reduceNotch — the happy S1→S6 walk", () => {
  it("dragEnter opens S3 with the first file's name", () => {
    const s = reduceNotch(
      NOTCH_IDLE,
      { type: "dragEnter", paths: ["/tmp/attention.pdf", "/tmp/b.md"] },
      T0,
    );
    expect(s.panel).toEqual({
      kind: "dragging",
      name: "attention.pdf",
      meta: "PDF · +1",
    });
  });

  it("dragLeave folds a drag back to idle, and only a drag", () => {
    const dragging = walk(NOTCH_IDLE, [
      { type: "dragEnter", paths: ["/tmp/a.pdf"] },
    ]);
    expect(reduceNotch(dragging, { type: "dragLeave" }, T0)).toBe(NOTCH_IDLE);
    const done: NotchDriverState = {
      panel: { kind: "done", summary: "x" },
      runningSince: null,
    };
    expect(reduceNotch(done, { type: "dragLeave" }, T0)).toBe(done);
  });

  it("a readable drop lands on S4 with the predicted name", () => {
    const s = walk(NOTCH_IDLE, [
      { type: "dragEnter", paths: ["/tmp/attention.pdf"] },
      { type: "drop", paths: ["/tmp/attention.pdf"] },
    ]);
    expect(s.panel).toEqual({ kind: "accepted", rel: "attention.pdf" });
  });

  it("writeOk refines the S4 row with what actually landed", () => {
    const s = walk(NOTCH_IDLE, [
      { type: "drop", paths: ["/tmp/attention.pdf"] },
      { type: "writeOk", summary: "attention-2.pdf" },
    ]);
    expect(s.panel).toEqual({ kind: "accepted", rel: "attention-2.pdf" });
  });

  it("a status push moves S4 to S5 and times the run from that push", () => {
    const s = walk(NOTCH_IDLE, [
      { type: "drop", paths: ["/tmp/attention.pdf"] },
      { type: "statusPush", running: "Ingesting attention.pdf", at: T0 },
      { type: "tick", at: T0 + 42_000 },
    ]);
    expect(s.panel).toEqual({
      kind: "running",
      percent: 0,
      detail: "Ingesting attention.pdf",
      elapsedMs: 42_000,
    });
    expect(s.runningSince).toBe(T0);
  });

  it("repeated pushes keep the original start time", () => {
    const s = walk(NOTCH_IDLE, [
      { type: "statusPush", running: "reindex 10/302", at: T0 },
      { type: "statusPush", running: "reindex 218/302", at: T0 + 30_000 },
    ]);
    expect(s.runningSince).toBe(T0);
    expect(s.panel.kind).toBe("running");
    if (s.panel.kind === "running") {
      expect(s.panel.elapsedMs).toBe(30_000);
      expect(s.panel.percent).toBe(72);
    }
  });

  it("the run ending becomes S6 carrying the last detail line", () => {
    const s = walk(NOTCH_IDLE, [
      { type: "statusPush", running: "reindex 218/302", at: T0 },
      { type: "statusPush", running: null, at: T0 + 60_000 },
    ]);
    expect(s.panel).toEqual({ kind: "done", summary: "reindex 218/302" });
    expect(s.runningSince).toBeNull();
  });

  it("idleTimeout folds S6 back to S1", () => {
    const done: NotchDriverState = {
      panel: { kind: "done", summary: "x" },
      runningSince: null,
    };
    expect(reduceNotch(done, { type: "idleTimeout" }, T0)).toBe(NOTCH_IDLE);
  });
});

describe("reduceNotch — refusals", () => {
  it("an all-unsupported drop lands on S9 with the templated reason", () => {
    const s = reduceNotch(
      NOTCH_IDLE,
      {
        type: "drop",
        paths: ["/tmp/book.epub"],
        unsupportedTemplate: "no reader for {ext}",
      },
      T0,
    );
    expect(s.panel).toEqual({
      kind: "rejected",
      ext: ".epub",
      reason: "no reader for .epub",
    });
  });

  it("a mixed drop shows the accepted side — the readable files landed", () => {
    const s = reduceNotch(
      NOTCH_IDLE,
      { type: "drop", paths: ["/tmp/a.pdf", "/tmp/book.epub", "/tmp/b.md"] },
      T0,
    );
    expect(s.panel).toEqual({ kind: "accepted", rel: "a.pdf +1" });
  });

  it("an empty drop shows nothing at all", () => {
    expect(reduceNotch(NOTCH_IDLE, { type: "drop", paths: [] }, T0)).toBe(
      NOTCH_IDLE,
    );
  });

  it("writeFail turns S4 into S9 with the failure as the reason", () => {
    const s = walk(NOTCH_IDLE, [
      { type: "drop", paths: ["/tmp/a.pdf"] },
      { type: "writeFail", reason: "disk full" },
    ]);
    expect(s.panel).toEqual({ kind: "rejected", ext: "", reason: "disk full" });
  });
});

describe("reduceNotch — what must NOT be interrupted", () => {
  it("a background run never talks over a drag in progress", () => {
    const dragging = walk(NOTCH_IDLE, [
      { type: "dragEnter", paths: ["/tmp/a.pdf"] },
    ]);
    expect(
      reduceNotch(dragging, { type: "statusPush", running: "reindex" }, T0),
    ).toBe(dragging);
  });

  it("a background run waits for a refusal to be read", () => {
    const rejected: NotchDriverState = {
      panel: { kind: "rejected", ext: ".epub" },
      runningSince: null,
    };
    expect(
      reduceNotch(rejected, { type: "statusPush", running: "reindex" }, T0),
    ).toBe(rejected);
  });

  it("a stale writeOk cannot clobber a newer drag", () => {
    const dragging = walk(NOTCH_IDLE, [
      { type: "dragEnter", paths: ["/tmp/b.md"] },
    ]);
    expect(
      reduceNotch(dragging, { type: "writeOk", summary: "a.pdf" }, T0),
    ).toBe(dragging);
  });

  it("a stale idleTimeout cannot kill a state with a live owner", () => {
    const dragging = walk(NOTCH_IDLE, [
      { type: "dragEnter", paths: ["/tmp/b.md"] },
    ]);
    expect(reduceNotch(dragging, { type: "idleTimeout" }, T0)).toBe(dragging);
  });

  it("idle no-op pushes return the SAME state, so timers are not rearmed", () => {
    expect(
      reduceNotch(NOTCH_IDLE, { type: "statusPush", running: null }, T0),
    ).toBe(NOTCH_IDLE);
    expect(reduceNotch(NOTCH_IDLE, { type: "tick" }, T0)).toBe(NOTCH_IDLE);
    expect(reduceNotch(NOTCH_IDLE, { type: "dragOver" }, T0)).toBe(NOTCH_IDLE);
  });
});

describe("reduceNotch — S7 text capture", () => {
  const capture = walk(NOTCH_IDLE, [{ type: "captureOpen" }]);

  it("captureOpen opens the input from idle, and from idle only", () => {
    expect(capture.panel).toEqual({ kind: "capture", text: "" });
    const done: NotchDriverState = {
      panel: { kind: "done", summary: "x" },
      runningSince: null,
    };
    expect(reduceNotch(done, { type: "captureOpen" }, T0)).toBe(done);
  });

  it("submit shows the predicted daily path at once; the save refines it", () => {
    const submitted = reduceNotch(capture, { type: "captureSubmit" }, T0);
    expect(submitted.panel).toEqual({
      kind: "captured",
      rel: `daily/${today(new Date(T0))}.md`,
    });
    const saved = reduceNotch(
      submitted,
      { type: "captureSaved", rel: "daily/2026-08-25.md" },
      T0,
    );
    expect(saved.panel).toEqual({
      kind: "captured",
      rel: "daily/2026-08-25.md",
    });
  });

  it("a failed save becomes a rejection carrying the translated reason", () => {
    const submitted = reduceNotch(capture, { type: "captureSubmit" }, T0);
    const failed = reduceNotch(
      submitted,
      { type: "captureFail", reason: "no vault open" },
      T0,
    );
    expect(failed.panel).toEqual({
      kind: "rejected",
      ext: "",
      reason: "no vault open",
    });
  });

  it("esc folds the input back to idle — but never a bystander state", () => {
    expect(reduceNotch(capture, { type: "captureCancel" }, T0)).toBe(
      NOTCH_IDLE,
    );
    const done: NotchDriverState = {
      panel: { kind: "done", summary: "x" },
      runningSince: null,
    };
    expect(reduceNotch(done, { type: "captureCancel" }, T0)).toBe(done);
  });

  it("a background run never talks over the capture input", () => {
    expect(
      reduceNotch(capture, { type: "statusPush", running: "reindex" }, T0),
    ).toBe(capture);
  });
});

describe("reduceNotch — S8 voice capture", () => {
  const capture = walk(NOTCH_IDLE, [{ type: "captureOpen" }]);
  const recording = walk(NOTCH_IDLE, [
    { type: "captureOpen" },
    { type: "recStart" },
  ]);

  it("recStart opens the take empty; recTick walks the clock", () => {
    expect(recording.panel).toEqual({
      kind: "recording",
      elapsedMs: 0,
      caption: EMPTY_CAPTION,
      noInput: false,
    });
    expect(recording.runningSince).toBe(T0);
    const ticked = reduceNotch(recording, { type: "recTick" }, T0 + 7000);
    expect(ticked.panel).toEqual({
      kind: "recording",
      elapsedMs: 7000,
      caption: EMPTY_CAPTION,
      noInput: false,
    });
  });

  it("the caption and the silence verdict survive the clock tick", () => {
    // The ticker knows nothing about either — a tick that dropped them would
    // blank the transcript once a second.
    const caption = { confirmed: ["오늘"], interim: ["회의"] };
    const live = walk(recording, [
      { type: "recCaption", caption },
      { type: "recNoInput", noInput: true },
    ]);
    const ticked = reduceNotch(live, { type: "recTick" }, T0 + 3000);
    expect(ticked.panel).toEqual({
      kind: "recording",
      elapsedMs: 3000,
      caption,
      noInput: true,
    });
  });

  it("recStop reports the transcribe, holding the clock and the caption", () => {
    const caption = { confirmed: ["오늘"], interim: [] };
    const stopped = reduceNotch(
      walk(reduceNotch(recording, { type: "recTick" }, T0 + 7000), [
        { type: "recCaption", caption },
      ]),
      { type: "recStop" },
      T0 + 7000,
    );
    expect(stopped.panel).toEqual({
      kind: "saving",
      elapsedMs: 7000,
      caption,
      stage: "transcribing",
      pct: null,
      note: undefined,
    });
    expect(stopped.runningSince).toBeNull();
  });

  it("recStage fills whisper's meter, then names the write half", () => {
    const saving = reduceNotch(recording, { type: "recStop" }, T0);
    const at40 = reduceNotch(
      saving,
      { type: "recStage", stage: "transcribing", pct: 40 },
      T0,
    );
    expect(at40.panel).toMatchObject({ kind: "saving", pct: 40 });
    const writing = reduceNotch(
      at40,
      { type: "recStage", stage: "saving", pct: 100 },
      T0,
    );
    expect(writing.panel).toMatchObject({ kind: "saving", stage: "saving" });
  });

  it("recStage never touches a LIVE take", () => {
    // whisper-transcribe-progress is app-wide: an ingest running in the main
    // window must not tear down the recording surface (and with it the ⏎/esc
    // keys) while the mic is still open.
    expect(
      reduceNotch(
        recording,
        { type: "recStage", stage: "transcribing", pct: 10 },
        T0,
      ),
    ).toBe(recording);
  });

  it("esc on a live take says so for 800ms before folding", () => {
    const cancelled = reduceNotch(recording, { type: "recCancelled" }, T0);
    expect(cancelled.panel).toEqual({ kind: "cancelled" });
    expect(dwellMsFor(cancelled.panel)).toBe(CANCELLED_DWELL_MS);
    expect(CANCELLED_DWELL_MS).toBe(800);
    // The dwell timer then folds it through the same idleTimeout path as S6.
    expect(reduceNotch(cancelled, { type: "idleTimeout" }, T0)).toBe(
      NOTCH_IDLE,
    );
    // Nothing else has a take to cancel.
    const done: NotchDriverState = {
      panel: { kind: "done", summary: "x" },
      runningSince: null,
    };
    expect(reduceNotch(done, { type: "recCancelled" }, T0)).toBe(done);
  });

  it("recSaved lands on S4 from the saving half too", () => {
    const saving = reduceNotch(recording, { type: "recStop" }, T0);
    const saved = reduceNotch(
      saving,
      { type: "recSaved", rel: "voice-2026-08-25-0912.md" },
      T0,
    );
    expect(saved.panel).toEqual({
      kind: "accepted",
      rel: "voice-2026-08-25-0912.md",
    });
  });

  it("recSaved lands on S4 — a voice note is an _inbox arrival", () => {
    const saved = reduceNotch(
      recording,
      { type: "recSaved", rel: "voice-2026-08-25-0912.md" },
      T0,
    );
    expect(saved.panel).toEqual({
      kind: "accepted",
      rel: "voice-2026-08-25-0912.md",
    });
    expect(saved.runningSince).toBeNull();
  });

  it("recFail rejects from recording AND from the preflight still in capture", () => {
    const fromRecording = reduceNotch(
      recording,
      { type: "recFail", reason: "whisper is not installed" },
      T0,
    );
    expect(fromRecording.panel).toEqual({
      kind: "rejected",
      ext: "",
      reason: "whisper is not installed",
    });
    const fromCapture = reduceNotch(
      capture,
      { type: "recFail", reason: "whisper is not installed" },
      T0,
    );
    expect(fromCapture.panel.kind).toBe("rejected");
    const done: NotchDriverState = {
      panel: { kind: "done", summary: "x" },
      runningSince: null,
    };
    expect(reduceNotch(done, { type: "recFail", reason: "x" }, T0)).toBe(done);
  });

  it("recFail from peek — S2's one-click Record fails before any take exists", () => {
    const peek = walk(NOTCH_IDLE, [{ type: "hoverEnter" }]);
    expect(peek.panel.kind).toBe("peek");
    expect(
      reduceNotch(peek, { type: "recFail", reason: "mic denied" }, T0).panel,
    ).toEqual({ kind: "rejected", ext: "", reason: "mic denied" });
    // And from idle, for a refusal slower than the peek's hover-out.
    expect(
      reduceNotch(NOTCH_IDLE, { type: "recFail", reason: "mic denied" }, T0)
        .panel.kind,
    ).toBe("rejected");
  });

  it("esc cancels a live take back to idle", () => {
    expect(reduceNotch(recording, { type: "captureCancel" }, T0)).toBe(
      NOTCH_IDLE,
    );
  });

  it("a background run never talks over a live mic", () => {
    expect(
      reduceNotch(recording, { type: "statusPush", running: "reindex" }, T0),
    ).toBe(recording);
  });
});

describe("dwellMsFor", () => {
  it("done keeps the sheet's 4s; accepted and rejected fold later", () => {
    expect(dwellMsFor({ kind: "done", summary: "" })).toBe(DONE_DWELL_MS);
    expect(dwellMsFor({ kind: "captured", rel: "" })).toBe(DONE_DWELL_MS);
    expect(dwellMsFor({ kind: "accepted", rel: "" })).toBe(ACCEPTED_DWELL_MS);
    expect(dwellMsFor({ kind: "rejected", ext: "" })).toBe(REJECTED_DWELL_MS);
  });

  it("live-owner states never self-collapse", () => {
    expect(dwellMsFor({ kind: "idle" })).toBeNull();
    expect(dwellMsFor({ kind: "dragging", name: "a", meta: "" })).toBeNull();
    expect(
      dwellMsFor({ kind: "running", percent: 0, detail: "", elapsedMs: 0 }),
    ).toBeNull();
  });
});

describe("label helpers", () => {
  it("dragLabel names the first file and counts the rest", () => {
    expect(dragLabel(["/a/b/paper.pdf"])).toEqual({
      name: "paper.pdf",
      meta: "PDF",
    });
    expect(dragLabel(["/a/노트.md", "/b/c.png", "/d"])).toEqual({
      name: "노트.md",
      meta: "MD · +2",
    });
    // A folder has no extension; the count still shows.
    expect(dragLabel(["/a/folder"])).toEqual({ name: "folder", meta: "" });
  });

  it("batchLabel suffixes only real batches", () => {
    expect(batchLabel("a.pdf", 1)).toBe("a.pdf");
    expect(batchLabel("a.pdf", 3)).toBe("a.pdf +2");
  });

  it("extLabel shows the dotted extension, or the name when there is none", () => {
    expect(extLabel("book.EPUB")).toBe(".epub");
    expect(extLabel("README")).toBe("README");
  });
});

describe("runningPercent", () => {
  it("reads a percent, a fraction, or honestly nothing", () => {
    expect(runningPercent("재색인 72%")).toBe(72);
    expect(runningPercent("재색인 218/302")).toBe(72);
    expect(runningPercent("Reflect 분석 중…")).toBe(0);
    expect(runningPercent("done 5/0")).toBe(0);
  });
});

describe("peek reports the day's work", () => {
  it("shows today's and overdue counts on the lip instead of the drop hint", () => {
    // The notch is passed over every day; a vault with work due should not get
    // a generic invitation. Counts come off the same tray push the popover uses.
    const s = reduceNotch(
      NOTCH_IDLE,
      { type: "hoverEnter", due: { today: 2, overdue: 1 } },
      T0,
    );
    expect(s.panel).toEqual({ kind: "peek", due: { today: 2, overdue: 1 } });
    const view = describeNotch(s.panel, STRINGS.en);
    expect(view.lip).toBe("2 today · 1 overdue");
    expect(view.tone).toBe("warn");
  });

  it("omits the overdue half when nothing is late", () => {
    const s = reduceNotch(
      NOTCH_IDLE,
      { type: "hoverEnter", due: { today: 3, overdue: 0 } },
      T0,
    );
    const view = describeNotch(s.panel, STRINGS.en);
    expect(view.lip).toBe("3 today");
    expect(view.tone).toBe("live");
  });

  it("falls back to the drop hint with nothing due, or no push yet", () => {
    for (const due of [{ today: 0, overdue: 0 }, undefined]) {
      const s = reduceNotch(NOTCH_IDLE, { type: "hoverEnter", due }, T0);
      expect(describeNotch(s.panel, STRINGS.en).lip).toBe(
        STRINGS.en.notch_peek ?? "Drop it here",
      );
    }
  });
});

describe("the global ⌥M", () => {
  it("starts a take from the states that can begin one", () => {
    for (const kind of ["idle", "peek", "capture"] as const) {
      expect(voiceHotkeyAction(kind)).toBe("start");
    }
  });

  it("SAVES a live take instead of discarding it", () => {
    expect(voiceHotkeyAction("recording")).toBe("stop");
  });

  it("leaves states that are reporting something alone", () => {
    for (const kind of [
      "dragging",
      "accepted",
      "running",
      "done",
      "captured",
      "cancelled",
      "saving",
      "rejected",
    ] as const) {
      expect(voiceHotkeyAction(kind)).toBe("ignore");
    }
  });
});

describe("the ⌥M double-fire gate", () => {
  it("drops a second delivery of the same press, then reopens", () => {
    const gate = createHotkeyGate(400);
    expect(gate(1_000)).toBe(true);
    // The window keydown listener firing alongside the OS hotkey event.
    expect(gate(1_005)).toBe(false);
    // A deliberate second press is not a double fire.
    expect(gate(1_500)).toBe(true);
  });
});
