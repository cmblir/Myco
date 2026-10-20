// The live panel's decisions, as pure functions (zustand renders its initial
// state under react-dom/server, so the panel cannot be driven from store
// state in this node environment).

import { describe, expect, it } from "vitest";
import { decisionLabel, feedIdleLine, pageCardCarriesTitle } from "./IngestProgress";
import { STRINGS } from "../lib/i18n";

describe("feedIdleLine", () => {
  it("does not announce agent warm-up for an unavailable terminal workflow", () => {
    expect(feedIdleLine("error", STRINGS.ko, "pending")).not.toBe(STRINGS.ko.ing_live_warmup);
  });
  it("says what the plan gate waits for instead of going blank", () => {
    // It is the polite live region's text before any event: an empty string
    // there announces nothing, and the activity feed shows an empty box.
    for (const t of [STRINGS.en, STRINGS.ko, STRINGS.ja]) {
      expect(feedIdleLine("plan-gate", t)).toBe(t.ing_gate_waiting);
      expect(t.ing_gate_waiting.length).toBeGreaterThan(0);
    }
  });

  it("keeps the warm-up line while the agent is starting", () => {
    expect(feedIdleLine("claude", STRINGS.en)).toBe(STRINGS.en.ing_live_warmup);
  });
});

describe("pageCardCarriesTitle", () => {
  it("drops the panel's title and ticker where the page shows its own card", () => {
    // done and cancelled each get one page card with the title; repeating it
    // in the panel over a frozen ticker read the terminal state twice.
    expect(pageCardCarriesTitle("done")).toBe(true);
    expect(pageCardCarriesTitle("cancelled")).toBe(true);
  });

  it("keeps them while running and avoids repeating the error card's title", () => {
    expect(pageCardCarriesTitle("error")).toBe(true);
    for (const stage of ["plan-gate", "claude", "indexing"] as const) {
      expect(pageCardCarriesTitle(stage)).toBe(false);
    }
  });
});

// UX S14: the plan card showed the planner's op codes, UPDATE / ADD / MERGE /
// NOOP, as its chips. They are words now, in every language.
describe("decisionLabel", () => {
  it("names each plan decision in the owner's words", () => {
    const ko = STRINGS.ko;
    expect(["UPDATE", "ADD", "MERGE", "NOOP"].map((d) => decisionLabel(ko, d))).toEqual([
      "고침",
      "새로 만듦",
      "합침",
      "이미 있음",
    ]);
  });

  it("never shows an op code, and the gate's hint names the label it explains", () => {
    for (const t of [STRINGS.en, STRINGS.ko, STRINGS.ja]) {
      for (const d of ["UPDATE", "ADD", "MERGE", "NOOP"] as const) {
        expect(decisionLabel(t, d)).not.toMatch(/UPDATE|ADD|MERGE|NOOP/);
      }
      expect(t.ingest_gate_noop_hint).not.toContain("NOOP");
      expect(t.ingest_gate_noop_hint).toContain(decisionLabel(t, "NOOP"));
      expect(t.ing_noop_reason).not.toContain("NOOP");
    }
  });
});
