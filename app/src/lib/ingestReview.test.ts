import { describe, expect, it } from "vitest";
import { ingestPageChanges, ingestReviewTitle } from "./ingestReview";

describe("observed ingest review", () => {
  it("distinguishes new and updated files using actual snapshots and puts content before maintenance pages", () => {
    const before = new Map([["/v/wiki/existing.md", 1], ["/v/wiki/log.md", 1]]);
    expect(ingestPageChanges(["wiki/log.md", "wiki/new.md", "wiki/existing.md"], "/v", before,
      [["/v/wiki/new.md", 2], ["/v/wiki/existing.md", 2], ["/v/wiki/log.md", 2]]))
      .toEqual([{ path: "wiki/new.md", change: "created" }, { path: "wiki/existing.md", change: "updated" },
        { path: "wiki/log.md", change: "updated" }]);
  });
  it("uses changed when a native receipt lacks before/after or timestamps cannot distinguish a write", () => {
    expect(ingestPageChanges(["wiki/a.md"], "/v")).toEqual([{ path: "wiki/a.md", change: "changed" }]);
    expect(ingestPageChanges(["wiki/a.md", "wiki/unobserved.md"], "/v", new Map([["/v/wiki/a.md", 1]]), [["/v/wiki/a.md", 1]]))
      .toEqual([{ path: "wiki/a.md", change: "changed" }, { path: "wiki/unobserved.md", change: "changed" }]);
  });
  it("uses the actual title and preserves a readable fallback for opaque session names", () => {
    expect(ingestReviewTitle("wiki/source-session-codex-0123456789abcdef.md", "Synthetic architecture review"))
      .toBe("Synthetic architecture review");
    expect(ingestReviewTitle("wiki/source-session-codex-0123456789abcdef.md")).toBe("Codex · 01234567");
  });
});
