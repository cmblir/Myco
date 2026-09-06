// The two pure decisions behind the sidebar status strip: what the vault tile
// counts, and which single warning the strip shows.

import { describe, expect, it } from "vitest";
import { statusWarning, vaultSplit } from "./StatusStrip";

const FILES = [
  "/v/sessions/2026-09/a.md",
  "/v/sessions/2026-09/b.md",
  "/v/wiki/attention.md",
  "/v/daily/2026-09-06.md",
];

describe("vaultSplit", () => {
  it("counts sessions and wiki separately, everything in the total", () => {
    expect(vaultSplit(FILES, "/v")).toEqual({ total: 4, sessions: 2, wiki: 1 });
  });

  it("accepts a root with a trailing slash and does not match a mere prefix", () => {
    expect(vaultSplit(["/v/wikipedia/x.md"], "/v/").wiki).toBe(0);
  });

  it("counts nothing per-folder without a vault root", () => {
    expect(vaultSplit(FILES, undefined)).toEqual({ total: 4, sessions: 0, wiki: 0 });
  });
});

describe("statusWarning", () => {
  it("is silent while every source is healthy", () => {
    expect(statusWarning({ mcpRunning: true, wikiPages: 269, indexedPages: 269 })).toBeNull();
  });

  it("flags an index that holds fewer pages than the wiki has", () => {
    expect(statusWarning({ mcpRunning: true, wikiPages: 269, indexedPages: 238 })).toBe("index");
  });

  it("a stopped MCP server outranks a lagging index", () => {
    expect(statusWarning({ mcpRunning: false, wikiPages: 269, indexedPages: 0 })).toBe("mcp");
  });

  it("says nothing while a source has not answered yet", () => {
    expect(statusWarning({ mcpRunning: null, wikiPages: 269, indexedPages: null })).toBeNull();
  });
});
