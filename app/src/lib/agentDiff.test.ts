import { describe, expect, it } from "vitest";
import { buildWritePreview } from "./agentDiff";

describe("buildWritePreview", () => {
  it("treats null current as a create: all-add lines", () => {
    const p = buildWritePreview("wiki/new.md", null, "# 제목\n본문입니다");
    expect(p.path).toBe("wiki/new.md");
    expect(p.kind).toBe("create");
    expect(p.truncated).toBe(false);
    expect(p.lines).toEqual([
      { kind: "add", segs: [{ kind: "add", text: "# 제목" }] },
      { kind: "add", segs: [{ kind: "add", text: "본문입니다" }] },
    ]);
  });

  it("word-marks exactly the changed word on an update", () => {
    const p = buildWritePreview(
      "wiki/a.md",
      "임계값은 0.45가 기준이다",
      "임계값은 0.50이 기준이다",
    );
    expect(p.kind).toBe("update");
    expect(p.truncated).toBe(false);
    expect(p.lines).toEqual([
      {
        kind: "del",
        segs: [
          { kind: "same", text: "임계값은 " },
          { kind: "del", text: "0.45가" },
          { kind: "same", text: " 기준이다" },
        ],
      },
      {
        kind: "add",
        segs: [
          { kind: "same", text: "임계값은 " },
          { kind: "add", text: "0.50이" },
          { kind: "same", text: " 기준이다" },
        ],
      },
    ]);
  });

  it("flags content beyond 64 KiB and skips the diff", () => {
    const big = "x".repeat(64 * 1024 + 1);
    const p = buildWritePreview("wiki/big.md", null, big);
    expect(p.kind).toBe("create");
    expect(p.truncated).toBe(true);
    expect(p.lines).toEqual([]);
  });

  it("flags an oversized current side too", () => {
    const big = "y".repeat(64 * 1024 + 1);
    const p = buildWritePreview("wiki/big.md", big, "짧은 새 내용");
    expect(p.kind).toBe("update");
    expect(p.truncated).toBe(true);
    expect(p.lines).toEqual([]);
  });
});
