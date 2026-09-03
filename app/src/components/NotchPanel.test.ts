// The notch surface's state → display mapping. Only the pure parts are tested:
// this repo's vitest is node-only (see vitest.config.ts), so there is no DOM to
// render into — which is exactly why describeNotch exists as a function rather
// than a pile of ternaries inside the JSX.
//
// What this guards: the ten design-sheet states each land on the right lip
// copy and the right cap tone, and the colour rule holds — purple only while
// something is alive, amber only on a refusal, green only when finished.

import { describe, expect, it } from "vitest";
import {
  CANCELLED_DWELL_MS,
  DONE_DWELL_MS,
  MOCK_FRAMES,
  clampPercent,
  clock,
  describeNotch,
  type NotchState,
} from "./NotchPanel";
import { STRINGS } from "../lib/i18n";
import { EMPTY_CAPTION } from "../lib/liveCaption";

const t = STRINGS.en;

describe("describeNotch", () => {
  it("S1 idle shows the bare dim cap and no label", () => {
    expect(describeNotch({ kind: "idle" }, t)).toEqual({
      lip: "",
      tone: "dim",
      open: false,
      dwellMs: null,
    });
  });

  it("S10 pill fallback stays collapsed but names itself", () => {
    // With no notch to hide inside, an unlabelled black pill is just a smudge.
    expect(describeNotch({ kind: "idle" }, t, true)).toEqual({
      lip: "MYCO",
      tone: "live",
      open: false,
      dwellMs: null,
    });
  });

  it("S2 peek invites without accepting", () => {
    const view = describeNotch({ kind: "peek" }, t);
    expect(view.lip).toBe(t.notch_peek);
    expect(view.tone).toBe("live");
    expect(view.open).toBe(true);
  });

  it("S3 drag enter opens with the live tone", () => {
    const view = describeNotch(
      { kind: "dragging", name: "attention.pdf", meta: "PDF · 2.4 MB" },
      t,
    );
    expect(view.lip).toBe(t.notch_drop);
    expect(view.tone).toBe("live");
    expect(view.open).toBe(true);
  });

  it("S4 accepted opens with the live tone", () => {
    const view = describeNotch({ kind: "accepted", rel: "attention.pdf" }, t);
    expect(view.lip).toBe(t.notch_accepted);
    expect(view.tone).toBe("live");
    expect(view.open).toBe(true);
  });

  it("S5 running interpolates the padded clock into the lip", () => {
    const view = describeNotch(
      { kind: "running", percent: 72, detail: "self-attention", elapsedMs: 42_000 },
      t,
    );
    expect(view.lip).toBe("Ingesting · 00:42");
    expect(view.lip).not.toContain("{t}");
    expect(view.tone).toBe("live");
  });

  it("S6 done goes green and folds itself away after 4s", () => {
    const view = describeNotch({ kind: "done", summary: "3 pages" }, t);
    expect(view.tone).toBe("ok");
    expect(view.dwellMs).toBe(DONE_DWELL_MS);
    expect(DONE_DWELL_MS).toBe(4000);
  });

  it("S7 text capture opens with the live tone", () => {
    const view = describeNotch({ kind: "capture", text: "why OTP" }, t);
    expect(view.lip).toBe(t.notch_capture);
    expect(view.tone).toBe("live");
    expect(view.open).toBe(true);
  });

  it("S7 saved goes green and folds on S6's 4s clock", () => {
    const view = describeNotch({ kind: "captured", rel: "daily/2026-08-25.md" }, t);
    expect(view.lip).toBe(t.notch_capture_saved);
    expect(view.tone).toBe("ok");
    expect(view.dwellMs).toBe(DONE_DWELL_MS);
  });

  it("S8 recording interpolates its own clock", () => {
    const view = describeNotch(
      {
        kind: "recording",
        elapsedMs: 7000,
        caption: EMPTY_CAPTION,
        noInput: false,
      },
      t,
    );
    expect(view.lip).toBe("Recording · 00:07");
    expect(view.tone).toBe("live");
  });

  it("a silent mic replaces the clock — the lip is the only place it shows", () => {
    // The complaint this whole pass answers: a muted or wrong mic looked
    // exactly like a working one, so a 13 s take could capture nothing.
    const view = describeNotch(
      {
        kind: "recording",
        elapsedMs: 7000,
        caption: EMPTY_CAPTION,
        noInput: true,
      },
      t,
    );
    expect(view.lip).toBe(t.notch_no_sound);
  });

  it("S8 cancelled goes amber and folds itself after 800ms", () => {
    const view = describeNotch({ kind: "cancelled" }, t);
    expect(view.lip).toBe(t.notch_cancelled);
    expect(view.tone).toBe("warn");
    expect(view.dwellMs).toBe(CANCELLED_DWELL_MS);
    expect(CANCELLED_DWELL_MS).toBe(800);
  });

  it("S8 saving names the stage on the lip, never 'Recording'", () => {
    // A ticking "Recording · 00:07" beside "Transcribing… 40%" reads as a mic
    // still running; the frozen clock stays in the body row.
    const view = describeNotch(
      {
        kind: "saving",
        elapsedMs: 7000,
        caption: EMPTY_CAPTION,
        stage: "transcribing",
        pct: 40,
      },
      t,
    );
    expect(view.lip).toBe(t.voice_stage_transcribing);
    expect(view.tone).toBe("live");
    expect(view.dwellMs).toBeNull();
    expect(
      describeNotch(
        {
          kind: "saving",
          elapsedMs: 7000,
          caption: EMPTY_CAPTION,
          stage: "saving",
          pct: 100,
        },
        t,
      ).lip,
    ).toBe(t.voice_stage_saving);
  });

  it("S9 rejection is the only amber state", () => {
    const view = describeNotch({ kind: "rejected", ext: ".epub" }, t);
    expect(view.lip).toBe(t.notch_rejected);
    expect(view.tone).toBe("warn");
    // A refusal is never silent: it has to open to say what would work.
    expect(view.open).toBe(true);
  });

  it("only the finished states — and the cancelled beat — self-collapse", () => {
    const dwelling = MOCK_FRAMES.filter(
      (f) => describeNotch(f.state, t, f.pill).dwellMs !== null,
    );
    expect(dwelling.map((f) => f.state.kind)).toEqual([
      "done",
      "captured",
      "cancelled",
    ]);
  });

  it("every state but idle unfolds the body", () => {
    const collapsed = MOCK_FRAMES.filter(
      (f) => !describeNotch(f.state, t, f.pill).open,
    );
    expect(collapsed.map((f) => f.state.kind)).toEqual(["idle", "idle"]);
  });

  it("translates every state in every language without leaving a placeholder", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      for (const frame of MOCK_FRAMES) {
        const view = describeNotch(frame.state, STRINGS[lang], frame.pill);
        expect(view.lip).not.toContain("{");
        // Idle in the notch is the one state that says nothing.
        if (frame.state.kind !== "idle" || frame.pill) {
          expect(view.lip.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("MOCK_FRAMES", () => {
  it("walks the design sheet's states in order (plus S7's saved outcome)", () => {
    expect(MOCK_FRAMES.map((f) => f.state.kind)).toEqual([
      "idle",
      "peek",
      "dragging",
      "accepted",
      "running",
      "done",
      "capture",
      "captured",
      "recording",
      "saving",
      "cancelled",
      "rejected",
      "idle",
    ]);
    // S10 is the only pill frame.
    expect(MOCK_FRAMES.filter((f) => f.pill)).toHaveLength(1);
    expect(MOCK_FRAMES[MOCK_FRAMES.length - 1].pill).toBe(true);
  });

  it("covers every kind of the union", () => {
    const kinds: NotchState["kind"][] = [
      "idle",
      "peek",
      "dragging",
      "accepted",
      "running",
      "done",
      "capture",
      "captured",
      "recording",
      "saving",
      "cancelled",
      "rejected",
    ];
    const seen = new Set(MOCK_FRAMES.map((f) => f.state.kind));
    expect([...kinds].filter((k) => !seen.has(k))).toEqual([]);
  });
});

describe("clock", () => {
  it("zero-pads the minute so the lip does not shift on rollover", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(7000)).toBe("00:07");
    expect(clock(42_000)).toBe("00:42");
    expect(clock(600_000)).toBe("10:00");
    // Every reading is the same width until the hour mark.
    expect(clock(0)).toHaveLength(clock(599_000).length);
  });
});

describe("clampPercent", () => {
  it("keeps a meter width inside 0–100", () => {
    expect(clampPercent(72)).toBe(72);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(71.6)).toBe(72);
  });

  it("turns NaN into 0 rather than `width: NaN%`", () => {
    // A CSS length of NaN drops the whole declaration, leaving a full-width
    // bar that reads as 100% done.
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  it("clamps an overflowing reading to full, not empty", () => {
    // Past-full means done, not stalled — 0 here would show a finished job as
    // a bar that never started.
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
