// The one piece of real logic on the quarantine tab's TS side: turning a
// verdict sidecar into a sentence with the real numbers in it. The threshold
// lives nowhere but inside `reason` (ontology::describe's prose), so parsing it
// out is the part that can silently regress.

import { describe, expect, it } from "vitest";
import {
  batchConfirm,
  daysLeft,
  groupLabel,
  groupQuarantine,
  ttlLine,
  verdictSentence,
  verdictThreshold,
} from "./quarantine";
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
  asks_on_expiry: false,
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

describe("groupQuarantine", () => {
  const q = (name: string, reason: string): QuarantineItem =>
    item({ path: `_inbox/quarantine/${name}`, name, reason, s_knn: 0, nearest_cluster: "" });

  it("groups machine sessions by kind in a fixed order, the rest last", () => {
    const items = [
      q("off.md", item().reason),
      q("e.md", "machine:empty"),
      q("h.md", "machine:hello"),
      q("m1.md", "machine:myco"),
      q("a.md", "machine:agent"),
      q("m2.md", "machine:myco"),
      q("broken.md", ""),
    ];
    const groups = groupQuarantine(items);
    expect(groups.map((g) => g.key)).toEqual(["myco", "agent", "hello", "empty", "other"]);
    // Within a group the backend's order (soonest expiry first) holds.
    expect(groups[0].items.map((i) => i.name)).toEqual(["m1.md", "m2.md"]);
    expect(groups[4].items.map((i) => i.name)).toEqual(["off.md", "broken.md"]);
  });

  it("leaves out groups with nothing in them", () => {
    expect(groupQuarantine([q("h.md", "machine:hello")]).map((g) => g.key)).toEqual(["hello"]);
    expect(groupQuarantine([])).toEqual([]);
  });

  it("puts a machine kind it does not know with the rest, not in a group of its own", () => {
    expect(groupQuarantine([q("x.md", "machine:future")]).map((g) => g.key)).toEqual(["other"]);
  });

  it("labels every group in plain words, in every language", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const labels = (["myco", "agent", "hello", "empty", "other"] as const).map((k) =>
        groupLabel(k, STRINGS[lang]),
      );
      expect(new Set(labels).size).toBe(5);
    }
    expect(groupLabel("myco", STRINGS.ko)).toBe("myco가 모델을 부른 기록");
    expect(groupLabel("agent", STRINGS.ko)).toBe("에이전트 작업 프롬프트");
    expect(groupLabel("hello", STRINGS.ko)).toBe("연결 테스트");
    expect(groupLabel("empty", STRINGS.ko)).toBe("빈 세션");
  });
});

describe("batchConfirm", () => {
  const group = { key: "hello" as const, items: [item(), item({ path: "_inbox/quarantine/b.md" })] };

  it("names the group and its count, and only trashing reads as dangerous", () => {
    const restore = batchConfirm("restore", group, STRINGS.ko);
    expect(restore.title).toContain("2");
    expect(restore.message).toContain("연결 테스트");
    expect(restore.confirmLabel).toBe(STRINGS.ko.qz_restore_all);
    expect(restore.danger).toBe(false);
    const trash = batchConfirm("trash", group, STRINGS.en);
    expect(trash.title).toContain("2");
    expect(trash.message).toContain("Connection tests");
    expect(trash.confirmLabel).toBe(STRINGS.en.qz_trash_all);
    expect(trash.danger).toBe(true);
  });
});

// Decision 5: an expired session is never trashed by a run, only proposed for
// deletion, so its card must not say it may go to the trash.
describe("ttlLine", () => {
  const now = Date.UTC(2026, 9, 2);
  const due = now / 1000 - 86_400;

  it("describes permanent expiry without weakening approval requirements", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const tl = STRINGS[lang];
      expect(ttlLine(item({ expires: due }), tl, now, true)).toBe(tl.qz_expires_due_permanent);
      expect(ttlLine(item({ expires: due, asks_on_expiry: true }), tl, now, true)).toBe(tl.qz_expires_due_ask);
      const confirmation = batchConfirm("trash", { key: "hello", items: [item()] }, tl, true);
      expect(confirmation.message).toBe(tl.delete_permanent_msg.replace("{n}", "1"));
      expect(confirmation.confirmLabel).toBe(tl.set_delete_permanent);
      expect(confirmation.danger).toBe(true);
    }
  });

  it("says the run asks first for an item it will only propose to delete", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const tl = STRINGS[lang];
      const session = item({ reason: "machine:myco", expires: due, asks_on_expiry: true });
      expect(ttlLine(session, tl, now)).toBe(tl.qz_expires_due_ask);
      expect(ttlLine(item({ expires: due }), tl, now)).toBe(tl.qz_expires_due);
    }
  });

  it("never claims the trash when the backend did not say so", () => {
    const unknown = { ...item({ expires: due }), asks_on_expiry: undefined } as unknown as QuarantineItem;
    expect(ttlLine(unknown, t, now)).toBe(t.qz_expires_due_ask);
  });

  it("counts the days while one is left, and owns up to a missing expiry", () => {
    expect(ttlLine(item({ expires: now / 1000 + 3 * 86_400, asks_on_expiry: true }), t, now)).toBe(
      "3 days left",
    );
    expect(ttlLine(item({ expires: 0 }), t, now)).toBe(t.qz_expires_unknown);
  });
});
