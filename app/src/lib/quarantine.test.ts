// The one piece of real logic on the quarantine tab's TS side: turning a
// verdict sidecar into a sentence with the real numbers in it. The threshold
// lives nowhere but inside `reason` (ontology::describe's prose), so parsing it
// out is the part that can silently regress.

import { describe, expect, it } from "vitest";
import { daysLeft, verdictSentence, verdictThreshold } from "./quarantine";
import type { QuarantineItem } from "./quarantine";
import { STRINGS } from "./i18n";

const t = STRINGS.en;

const item = (over: Partial<QuarantineItem> = {}): QuarantineItem => ({
  path: "_inbox/quarantine/a.md",
  name: "a.md",
  s_knn: 0.31,
  nearest_cluster: "transformers",
  reason:
    "nearest topic 'transformers' similarity 0.31 < quarantine 0.38 (p5) -> quarantine; 0 known entities",
  expires: 0,
  preview: "body",
  ...over,
});

describe("verdictThreshold", () => {
  it("reads the threshold out of a real describe() reason", () => {
    expect(verdictThreshold(item().reason)).toBe(0.38);
  });

  it("reads it from the cleared-the-bar wording too", () => {
    expect(
      verdictThreshold(
        "nearest topic 'rope' similarity 0.42 >= quarantine 0.4 (p5) -> quarantine; 1 known entity",
      ),
    ).toBe(0.4);
  });

  it("is null when the reason has no threshold at all", () => {
    expect(verdictThreshold("")).toBeNull();
    expect(verdictThreshold("junk heuristic: 91% tool-noise lines")).toBeNull();
  });
});

describe("verdictSentence", () => {
  it("states similarity against the threshold, and names the nearest topic", () => {
    expect(verdictSentence(item(), t)).toBe(
      "Off-topic: similarity 0.31 vs threshold 0.38 (nearest topic: transformers)",
    );
  });

  it("drops the threshold clause when the reason carries no threshold", () => {
    // The junk path (too short / tool noise) never compares against one.
    expect(
      verdictSentence(
        item({ reason: "junk heuristic: 412 bytes (< 600)", nearest_cluster: "" }),
        t,
      ),
    ).toBe("Off-topic: similarity 0.31");
  });

  it("says a malformed sidecar has no verdict instead of inventing 0.00", () => {
    expect(
      verdictSentence(item({ reason: "", s_knn: 0, nearest_cluster: "" }), t),
    ).toBe("No verdict recorded for this item.");
  });

  it("still reports the score when only the reason is missing", () => {
    expect(verdictSentence(item({ reason: "", nearest_cluster: "" }), t)).toBe(
      "Off-topic: similarity 0.31",
    );
  });
});

describe("daysLeft", () => {
  const now = 1_800_000_000_000; // ms

  it("rounds a partial day up", () => {
    expect(daysLeft(item({ expires: now / 1000 + 86_400 + 60 }), now)).toBe(2);
  });

  it("is 0 once the TTL is already past, never negative", () => {
    expect(daysLeft(item({ expires: now / 1000 - 999_999 }), now)).toBe(0);
  });

  it("is null when the sidecar recorded no expiry", () => {
    expect(daysLeft(item({ expires: 0 }), now)).toBeNull();
  });
});
