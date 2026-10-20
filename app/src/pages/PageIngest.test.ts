// The Ingest page's decisions, as pure functions. The ingest store is shared
// by every caller (this form, the headless inbox pass) and zustand renders its
// initial state under react-dom/server, so the page's markup cannot be driven
// from store state here; what it shows is decided by these helpers.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import {
  endNote,
  errorCardShown,
  heroMotion,
  railSteps,
  refusalNoteShown,
  runLinkRoot,
  userSteps,
} from "./PageIngest";
import { STRINGS } from "../lib/i18n";
import { SURFACE_CLIPS } from "../lib/mascotClips";
import type { IngestRefusal } from "../stores/ingestStore";

const DROP: IngestRefusal = {
  verdict: "drop",
  reason: "17 B < 200 B",
  rule: "junk_reason::min_bytes",
};

describe("refusalNoteShown", () => {
  const refused = { stage: "refused" as const, refusal: DROP, runId: "r1" };

  it("shows under the text this form sent, for the run it started", () => {
    expect(
      refusalNoteShown(refused, { runId: "r1", text: "too short" }, "too short"),
    ).toBe(true);
  });

  it("stays hidden for a headless inbox refusal under the user's own draft", () => {
    // runInboxPass refused an _inbox clip (run r2) while the form held a draft
    // it never submitted — "Clear text" there would delete that draft.
    expect(
      refusalNoteShown({ ...refused, runId: "r2" }, null, "my own draft"),
    ).toBe(false);
    expect(
      refusalNoteShown(
        { ...refused, runId: "r2" },
        { runId: "r1", text: "my own draft" },
        "my own draft",
      ),
    ).toBe(false);
  });

  it("stays hidden on a freshly mounted form (nothing submitted from it)", () => {
    expect(refusalNoteShown(refused, null, "")).toBe(false);
  });

  it("goes away once the text is edited after the refusal", () => {
    expect(
      refusalNoteShown(
        refused,
        { runId: "r1", text: "too short" },
        "too short, and now a much longer body",
      ),
    ).toBe(false);
  });

  it("needs a refused stage with a refusal", () => {
    const sent = { runId: "r1", text: "x" };
    expect(refusalNoteShown({ ...refused, stage: "done" }, sent, "x")).toBe(false);
    expect(refusalNoteShown({ ...refused, refusal: null }, sent, "x")).toBe(false);
  });
});

describe("runLinkRoot", () => {
  it("is the run's vault while that vault is open", () => {
    expect(runLinkRoot("/vaults/A", "/vaults/A")).toBe("/vaults/A");
  });

  it("is null once another vault is open", () => {
    // The in-app reader's read_file confines paths to the open vault, so a
    // link into the run's vault would fail to open.
    expect(runLinkRoot("/vaults/A", "/vaults/B")).toBeNull();
  });

  it("is null with no run vault or no open vault", () => {
    expect(runLinkRoot(null, "/vaults/A")).toBeNull();
    expect(runLinkRoot("/vaults/A", undefined)).toBeNull();
  });
});

describe("railSteps", () => {
  const t = STRINGS.en;

  it("a cancel at the plan gate reads steps 3-5 as never reached", () => {
    const r = railSteps("cancelled", 4, "gate", t);
    // The source passed the judge before the gate paused it.
    expect(r.judge).toBe("done");
    expect(r.gate).toEqual({ value: "—", state: undefined });
    expect(r.run).toEqual({ value: "—", state: undefined });
    expect(r.unreached).toBe(true);
  });

  it("a cancel mid-run keeps the gate it passed and reads the run as cancelled", () => {
    const r = railSteps("cancelled", 3, "run", t);
    expect(r.judge).toBe("done");
    expect(r.gate).toEqual({ value: "3", state: "done" });
    expect(r.run).toEqual({ value: t.sv_cancelled, state: undefined });
    expect(r.unreached).toBe(false);
  });

  it("keeps the refused, gate and done readings", () => {
    expect(railSteps("refused", 0, null, t)).toMatchObject({
      judge: "done",
      gate: { value: "—" },
      run: { value: "—" },
      unreached: true,
    });
    expect(railSteps("plan-gate", 2, null, t)).toMatchObject({
      gate: { value: t.sv_reviewing, state: "active" },
      run: { value: t.sv_idle, state: undefined },
      unreached: false,
    });
    expect(railSteps("done", 2, null, t)).toMatchObject({
      judge: "done",
      gate: { value: "2", state: "done" },
      run: { value: t.sv_done, state: "done" },
    });
  });
});

// UX S14: the bar said "유입 · 판정 버림 0 · 기록 0 · 수확 0 · 계획 게이트 ·
// 실행 유휴 · 백필 큐 2건 대기". A user follows three states; the five
// counters fold under 세부 정보.
describe("userSteps", () => {
  it.each(["pending", "partial", "stopped"] as const)("does not tick the end for a %s workflow with stage done", status => {
    expect(userSteps("done", true, null, status).end).toBeUndefined();
    expect(railSteps("done", 2, null, STRINGS.ko, status).run.state).toBeUndefined();
    expect(endNote("done", STRINGS.ko, status)).toBeDefined();
    expect(heroMotion("done", status).variant).toBe("idle");
  });
  it("reads while the source is judged, then moves on to the end", () => {
    expect(userSteps("writing-raw", false, null)).toEqual({
      read: "active",
      choose: undefined,
      end: undefined,
    });
    // After the gate myco writes the notes: the highlight moves forward to
    // 끝, never back to 읽는 중 under a ticked 고를 차례.
    for (const stage of ["claude", "indexing"] as const) {
      expect(userSteps(stage, true, null)).toEqual({ read: "done", choose: "done", end: "active" });
      expect(userSteps(stage, false, null)).toEqual({ read: "done", choose: undefined, end: "active" });
    }
  });

  it("is the user's turn to choose at the plan gate", () => {
    expect(userSteps("plan-gate", true, null)).toEqual({
      read: "done",
      choose: "active",
      end: undefined,
    });
  });

  it("keeps the choice ticked once the user chose at the gate", () => {
    expect(userSteps("done", true, null)).toEqual({ read: "done", choose: "done", end: "done" });
    expect(userSteps("cancelled", true, "run").choose).toBe("done");
    // "Apply 0" ends at refused (planGate::none_selected): the user did choose.
    expect(userSteps("refused", true, null).choose).toBe("done");
  });

  it("never ticks a choice the user was not asked for", () => {
    // A headless (auto-ingest) run has a plan but no gate, a streamless
    // provider has neither, and a cancel at the gate itself chose nothing.
    for (const stage of ["claude", "indexing", "done"] as const) {
      expect(userSteps(stage, false, null).choose).toBeUndefined();
    }
    expect(userSteps("cancelled", true, "gate").choose).toBeUndefined();
    expect(userSteps("refused", false, null).choose).toBeUndefined();
  });

  it("ticks 끝 only when the run added notes", () => {
    expect(userSteps("done", false, null).end).toBe("done");
    // A cancel or a refusal wrote nothing: no success check on the last step.
    expect(userSteps("cancelled", true, "gate").end).toBeUndefined();
    expect(userSteps("cancelled", true, "run").end).toBeUndefined();
    expect(userSteps("refused", false, null)).toEqual({ read: "done", choose: undefined, end: undefined });
    expect(userSteps("refused", true, null).end).toBeUndefined();
  });

  it("ticks nothing on an error — the error card says what happened", () => {
    expect(userSteps("error", true, null)).toEqual({ read: undefined, choose: undefined, end: undefined });
  });

  it("names the three states in the owner's words", () => {
    const ko = STRINGS.ko;
    expect([ko.sv_state_reading, ko.sv_state_choosing, ko.sv_state_done, ko.sv_details]).toEqual([
      "읽는 중",
      "고를 차례",
      "끝",
      "세부 정보",
    ]);
  });
});

// A failed, cancelled or refused run must say so on the bar itself: the
// cards that explain it sit under the form, often past the fold.
describe("endNote", () => {
  it("names on 끝 how a run ended without adding notes", () => {
    const ko = STRINGS.ko;
    expect(endNote("error", ko)).toBe(ko.sv_failed);
    expect(endNote("cancelled", ko)).toBe(ko.sv_cancelled);
    expect(endNote("refused", ko)).toBe("추가한 노트 없음");
  });

  it("says nothing while a run works or after it added notes", () => {
    for (const stage of ["writing-raw", "plan-gate", "claude", "indexing", "done"] as const) {
      expect(endNote(stage, STRINGS.en)).toBeUndefined();
    }
  });
});

describe("errorCardShown", () => {
  it("shows a streamless run's failure, not only a streamed one's", () => {
    // HTTP providers stream no events. The card was gated on events, so this
    // failure showed nowhere but the closed 세부 정보.
    expect(errorCardShown("error", "WARNING: the model finished but no wiki pages were created")).toBe(true);
  });

  it("needs an error with a log", () => {
    expect(errorCardShown("error", "")).toBe(false);
    expect(errorCardShown("done", "Done.")).toBe(false);
  });
});

describe("heroMotion", () => {
  it("rests while the plan gate waits on the user", () => {
    // Nothing is being written at the gate: no violet sweep, no "thinking".
    // "idle" (the slow breathe), not "welcome" — that one-shot greet with
    // sparks reads as something having just happened.
    expect(heroMotion("plan-gate")).toEqual({ spinning: false, variant: "idle" });
  });

  it("works while the run works, and settles after it", () => {
    for (const stage of ["writing-raw", "claude", "indexing"] as const) {
      expect(heroMotion(stage)).toEqual({ spinning: true, variant: "thinking" });
    }
    expect(heroMotion("done")).toEqual({ spinning: false, variant: "success" });
    expect(heroMotion("idle")).toEqual({ spinning: false, variant: "welcome" });
  });
});

// The hero slot is what the running ring and the grid centre hang off. A
// 96 px clip in the 72 px slot spilled 24 px right and down: MYCO sat 12 px
// off the ring and jumped 12 px whenever a clip started or stopped.
describe("the Ingest hero slot", () => {
  it("is the box SURFACE_CLIPS draws the hero clips in, at every width", () => {
    const root = postcss.parse(readFileSync(resolve(__dirname, "../styles/intake.css"), "utf8"));
    const px = (v: string | undefined): number | undefined =>
      v === undefined ? undefined : v.endsWith("rem") ? parseFloat(v) * 16 : parseFloat(v);
    const box: Record<string, number | undefined> = {};
    root.walkRules(".intake-page .u-hero__fig", (rule) => {
      // A width-only override inside a media query would undo it on a narrow window.
      expect(rule.parent?.type).toBe("root");
      rule.walkDecls((d) => {
        if (["width", "height", "flex-basis"].includes(d.prop)) box[d.prop] = px(d.value);
      });
    });
    const sizes = new Set(
      [SURFACE_CLIPS.ingestReceived, SURFACE_CLIPS.ingestRunning, SURFACE_CLIPS.ingestDone].map((s) => s.size),
    );
    expect(sizes.size).toBe(1);
    const [size] = sizes;
    expect(box).toEqual({ width: size, height: size, "flex-basis": size });
  });
});

// UX S35: a phone or touch screen has nothing to drop a file with, so its
// headline is "Choose a file", never "Drop a file here".
describe("the drop zone headline on a touch screen", () => {
  const root = postcss.parse(readFileSync(resolve(__dirname, "../styles/intake.css"), "utf8"));
  const hidden = (selector: string, inCoarse: boolean): boolean => {
    let found = false;
    root.walkRules(selector, (rule) => {
      const media = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : null;
      const coarse = media !== null && media.includes("pointer: coarse");
      if (coarse !== inCoarse || (media !== null && !coarse)) return;
      rule.walkDecls("display", (d) => {
        if (d.value === "none") found = true;
      });
    });
    return found;
  };

  it("hides the drop line under a coarse pointer and the pick line elsewhere", () => {
    expect(hidden(".intake-page .sv-dz-t__mouse", true)).toBe(true);
    expect(hidden(".intake-page .sv-dz-t__touch", false)).toBe(true);
    expect(hidden(".intake-page .sv-dz-t__mouse", false)).toBe(false);
  });

  it("says choose, not drop, in every language", () => {
    for (const t of [STRINGS.en, STRINGS.ko, STRINGS.ja]) {
      expect(t.ing_pick_file).not.toBe(t.ing_drop);
    }
    expect(STRINGS.ko.ing_pick_file).toBe("파일 고르기");
  });
});
