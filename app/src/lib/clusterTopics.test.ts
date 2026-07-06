import { describe, expect, it } from "vitest";
import { memberHash, sanitize } from "./clusterTopics";

describe("sanitize", () => {
  it("accepts a clean 1-3 word topic, trimming quotes and whitespace", () => {
    expect(sanitize("Alignment")).toBe("Alignment");
    expect(sanitize('  "Model Training"  ')).toBe("Model Training");
    expect(sanitize("- Fine tuning.\nExtra line ignored")).toBe("Fine tuning");
  });

  it("rejects junk: too long, too many words, structural chars, empty", () => {
    expect(
      sanitize("(mock) local model reply — the real app runs the model here."),
    ).toBeNull();
    expect(sanitize("one two three four five")).toBeNull();
    expect(sanitize("topic: alignment")).toBeNull();
    expect(sanitize("   ")).toBeNull();
  });
});

describe("memberHash", () => {
  it("is order-independent and path-insensitive (stems only)", () => {
    const a = memberHash(["/v/wiki/rlhf.md", "/v/wiki/dpo.md"]);
    const b = memberHash(["/other/dpo.md", "/x/rlhf.md"]);
    expect(a).toBe(b);
  });

  it("differs for different member sets and avoids concat collisions", () => {
    expect(memberHash(["ab.md", "c.md"])).not.toBe(memberHash(["a.md", "bc.md"]));
    expect(memberHash(["rlhf.md"])).not.toBe(memberHash(["rlhf.md", "dpo.md"]));
  });
});
