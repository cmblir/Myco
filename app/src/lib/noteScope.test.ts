import { describe, expect, it } from "vitest";
import { noteScopePaths } from "./noteScope";
import type { Adjacency } from "./ipc";

const adj = (forward: Record<string, string[]>, backward: Record<string, string[]>): Adjacency => ({
  forward,
  backward,
  unresolved: {},
  tags: {},
});

describe("noteScopePaths", () => {
  it("is the note and its one-hop links both ways, vault-relative, once each", () => {
    const a = adj(
      { "/v/wiki/a.md": ["/v/wiki/b.md", "/v/wiki/c.md"], "/v/wiki/b.md": ["/v/wiki/z.md"] },
      { "/v/wiki/a.md": ["/v/daily/2026-10-01.md", "/v/wiki/b.md"] },
    );
    expect(noteScopePaths("/v/wiki/a.md", "/v", a)).toEqual([
      "wiki/a.md",
      "wiki/b.md",
      "wiki/c.md",
      "daily/2026-10-01.md",
    ]);
  });

  it("is the note alone without a graph", () => {
    expect(noteScopePaths("/v/wiki/a.md", "/v", null)).toEqual(["wiki/a.md"]);
  });

  it("drops a link that resolves outside the vault", () => {
    const a = adj({ "/v/wiki/a.md": ["/elsewhere/x.md"] }, {});
    expect(noteScopePaths("/v/wiki/a.md", "/v", a)).toEqual(["wiki/a.md"]);
  });
});
