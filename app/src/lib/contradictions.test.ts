import { describe, expect, it } from "vitest";
import { findContradictions, setPageStatus } from "./contradictions";
import type { Adjacency } from "./ipc";

const ROOT = "/v";
const wiki = (name: string) => `${ROOT}/wiki/${name}`;

function adj(partial: Partial<Adjacency>): Adjacency {
  return { forward: {}, backward: {}, unresolved: {}, tags: {}, ...partial };
}

describe("findContradictions", () => {
  it("flags a disputed wiki page", () => {
    const a = adj({ meta: { [wiki("a.md")]: { status: "disputed" } } });
    expect(findContradictions(a, ROOT)).toEqual([
      { kind: "disputed", page: wiki("a.md"), rel: "wiki/a.md" },
    ]);
  });

  it("flags an active page linking to a superseded one, with the target", () => {
    // a.md has no meta entry at all — absent status counts as active.
    const a = adj({
      forward: { [wiki("a.md")]: [wiki("old.md")] },
      meta: { [wiki("old.md")]: { status: "superseded" } },
    });
    expect(findContradictions(a, ROOT)).toEqual([
      { kind: "stale-link", page: wiki("a.md"), rel: "wiki/a.md", target: "wiki/old.md" },
    ]);
  });

  it("does NOT flag a superseded page linking to a superseded one", () => {
    const a = adj({
      forward: { [wiki("b.md")]: [wiki("old.md")] },
      meta: {
        [wiki("b.md")]: { status: "superseded" },
        [wiki("old.md")]: { status: "superseded" },
      },
    });
    expect(findContradictions(a, ROOT)).toEqual([]);
  });

  it("skips non-wiki paths on both arms", () => {
    const a = adj({
      forward: { [`${ROOT}/daily/d.md`]: [wiki("old.md")] },
      meta: {
        [`${ROOT}/sessions/s.md`]: { status: "disputed" },
        [wiki("old.md")]: { status: "superseded" },
      },
    });
    expect(findContradictions(a, ROOT)).toEqual([]);
  });

  it("skips index.md", () => {
    const a = adj({ meta: { [wiki("index.md")]: { status: "disputed" } } });
    expect(findContradictions(a, ROOT)).toEqual([]);
  });
});

describe("setPageStatus", () => {
  it("replaces an existing frontmatter status", () => {
    const raw = "---\ntitle: X\nstatus: active\n---\n\nBody\n";
    expect(setPageStatus(raw, "superseded")).toBe(
      "---\ntitle: X\nstatus: superseded\n---\n\nBody\n",
    );
  });

  it("inserts status into frontmatter when absent", () => {
    const raw = "---\ntitle: X\n---\n\nBody\n";
    expect(setPageStatus(raw, "disputed")).toBe(
      "---\ntitle: X\nstatus: disputed\n---\n\nBody\n",
    );
  });

  it("creates a frontmatter block when the file has none", () => {
    expect(setPageStatus("# Title\n", "active")).toBe(
      "---\nstatus: active\n---\n\n# Title\n",
    );
  });

  it("leaves a body status: line untouched", () => {
    const raw = "---\nstatus: active\n---\n\nstatus: draft\n";
    expect(setPageStatus(raw, "superseded")).toBe(
      "---\nstatus: superseded\n---\n\nstatus: draft\n",
    );
    // Insert path too: only the frontmatter gains the key.
    const noKey = "---\ntitle: X\n---\n\nstatus: draft\n";
    expect(setPageStatus(noKey, "active")).toBe(
      "---\ntitle: X\nstatus: active\n---\n\nstatus: draft\n",
    );
  });
});
