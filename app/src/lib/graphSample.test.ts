import { describe, expect, it } from "vitest";
import { isSamplePath, SAMPLE_VAULT_PATHS } from "./graphSample";

describe("sample vault detection", () => {
  it("lists the 51 seeded notes of sample_vault.rs, no duplicates", () => {
    expect(SAMPLE_VAULT_PATHS).toHaveLength(51);
    expect(new Set(SAMPLE_VAULT_PATHS).size).toBe(51);
    expect(SAMPLE_VAULT_PATHS.every((p) => p.startsWith("wiki/") && p.endsWith(".md"))).toBe(true);
  });

  it("matches by vault-relative path, tolerating trailing slashes and backslashes", () => {
    expect(isSamplePath("/v", "/v/wiki/rlhf.md")).toBe(true);
    expect(isSamplePath("/v/", "/v/wiki/rlhf.md")).toBe(true);
    expect(isSamplePath("C:\\v", "C:\\v\\wiki\\rlhf.md")).toBe(true);
    expect(isSamplePath("", "wiki/rlhf.md")).toBe(true);
  });

  it("an owner's note and a ghost are never sample", () => {
    expect(isSamplePath("/v", "/v/wiki/my-rag-notes.md")).toBe(false);
    expect(isSamplePath("/v", "/v/notes/rlhf.md")).toBe(false);
    expect(isSamplePath("/v", "ghost:rlhf")).toBe(false);
  });
});
