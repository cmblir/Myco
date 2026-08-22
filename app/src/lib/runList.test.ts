import { describe, expect, it } from "vitest";
import { formatRunLine } from "./runList";

describe("formatRunLine", () => {
  it("shows relative time and non-zero counts only", () => {
    const now = Math.floor(Date.now() / 1000);
    const line = formatRunLine(
      { id: "digest-1", started_at: now - 3600, moves: 3, trashed: 0, created: 2 },
      "en",
    );
    expect(line).toMatch(/hour/);
    expect(line).toContain("3");
    expect(line).toContain("2");
    expect(line).not.toContain("trash");
  });
});
