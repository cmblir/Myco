import { describe, expect, it } from "vitest";
import type { FileNode, PageAuthorship } from "./ipc";
import type { LineRun } from "./ipc";
import {
  badgeView,
  filterHumanTree,
  gutterRuns,
  parentParagraph,
  replaceLines,
} from "./authorship";

const NOW = 1_756_000_000; // unix secs

const auth = (
  agent: number,
  human: number,
  lastHuman: number | null,
): PageAuthorship => ({
  agent_lines: agent,
  human_lines: human,
  last_human_at: lastHuman,
  runs: [],
});

describe("badgeView", () => {
  it("rounds percentages so they always sum to 100 (human gets the remainder)", () => {
    // 1/3 agent → 33%, human takes the remaining 67%.
    const v = badgeView(auth(1, 2, NOW - 3600), NOW, "en");
    expect(v.agentPct).toBe(33);
    expect(v.humanPct).toBe(67);
    expect(v.agentPct + v.humanPct).toBe(100);
    // A .5 case: 1/8 = 12.5% — whatever the rounding, the sum stays 100.
    const w = badgeView(auth(1, 7, NOW - 3600), NOW, "en");
    expect(w.agentPct + w.humanPct).toBe(100);
    // The devMock fixture shape.
    const x = badgeView(auth(38, 62, NOW - 3600), NOW, "en");
    expect(x.agentPct).toBe(38);
    expect(x.humanPct).toBe(62);
  });

  it("survives an empty file without NaN", () => {
    const v = badgeView(auth(0, 0, null), NOW, "en");
    expect(v.agentPct + v.humanPct).toBe(100);
  });

  it("maps null last_human_at to a null relative label", () => {
    expect(badgeView(auth(1, 1, null), NOW, "en").lastHumanRel).toBeNull();
  });

  it("renders a relative label when a human commit exists", () => {
    const v = badgeView(auth(1, 1, NOW - 2 * 86400), NOW, "en");
    expect(v.lastHumanRel).toBe("2 days ago");
  });
});

const file = (path: string): FileNode => ({
  kind: "file",
  name: path.split("/").pop() ?? path,
  path,
});
const dir = (path: string, children: FileNode[]): FileNode => ({
  kind: "directory",
  name: path.split("/").pop() ?? path,
  path,
  children,
});

describe("filterHumanTree", () => {
  const ROOT = "/v";

  it("prunes agent-touched files and keeps untracked ones", () => {
    const tree = [file("/v/wiki/agent.md"), file("/v/wiki/untracked.md")];
    const kept = filterHumanTree(tree, { "wiki/agent.md": true }, ROOT);
    expect(kept.map((n) => n.path)).toEqual(["/v/wiki/untracked.md"]);
  });

  it("keeps tracked-but-never-agent-touched files", () => {
    const tree = [file("/v/wiki/human.md")];
    const kept = filterHumanTree(tree, { "wiki/human.md": false }, ROOT);
    expect(kept.map((n) => n.path)).toEqual(["/v/wiki/human.md"]);
  });

  it("prunes a directory left empty by the filter", () => {
    const tree = [dir("/v/wiki", [file("/v/wiki/agent.md")])];
    expect(filterHumanTree(tree, { "wiki/agent.md": true }, ROOT)).toEqual([]);
  });

  it("keeps nested human files and drops only the agent siblings", () => {
    const tree = [
      dir("/v/wiki", [
        dir("/v/wiki/sub", [
          file("/v/wiki/sub/human.md"),
          file("/v/wiki/sub/agent.md"),
        ]),
        file("/v/wiki/top-agent.md"),
      ]),
    ];
    const kept = filterHumanTree(
      tree,
      { "wiki/sub/agent.md": true, "wiki/top-agent.md": true },
      ROOT,
    );
    expect(kept).toHaveLength(1);
    const wiki = kept[0];
    if (wiki.kind !== "directory") throw new Error("expected directory");
    expect(wiki.children).toHaveLength(1);
    const sub = wiki.children[0];
    if (sub.kind !== "directory") throw new Error("expected directory");
    expect(sub.children.map((n) => n.path)).toEqual(["/v/wiki/sub/human.md"]);
  });
});

const run = (
  from: number,
  to: number,
  agent: boolean,
  sha = "a".repeat(40),
  ts = 1_756_000_000,
): LineRun => ({ from, to, agent, sha, ts });

describe("gutterRuns", () => {
  // Lines:      1        2  3           4  5
  const DOC = "intro\n\nagent line\n\ntail\n";

  it("marks a paragraph one agent commit wrote as revertable", () => {
    const rs = gutterRuns([run(1, 2, false), run(3, 3, true, "b".repeat(40)), run(4, 6, false)], DOC);
    expect(rs.map((r) => [r.from, r.to, r.agent, r.revertable])).toEqual([
      [1, 1, false, false], // human paragraphs are never "revert the agent"
      [3, 3, true, true],
      [5, 5, false, false],
    ]);
    expect(rs[1].sha).toBe("b".repeat(40));
  });

  it("refuses a paragraph split across two commits", () => {
    // One paragraph (lines 1-2), two commits — no single parent to go back to.
    const doc = "first\nsecond\n\ntail\n";
    const rs = gutterRuns(
      [run(1, 1, true, "a".repeat(40)), run(2, 2, true, "b".repeat(40)), run(3, 4, false)],
      doc,
    );
    expect(rs[0]).toMatchObject({ from: 1, to: 2, agent: true, revertable: false });
  });

  it("refuses a paragraph edited since its commit (uncommitted blame sha)", () => {
    // A moved or hand-edited paragraph blames to the all-zero sha until it is
    // committed; there is no parent revision to read.
    const rs = gutterRuns([run(1, 1, true, "0".repeat(40))], "edited\n");
    expect(rs[0].revertable).toBe(false);
  });

  it("is empty with no history at all — the gutter takes no width", () => {
    expect(gutterRuns([], DOC)).toEqual([]);
  });
});

describe("parentParagraph / replaceLines", () => {
  const parent = "# T\n\nold claim\n\ntail\n";
  const current = "# T\n\nnew claim\nsecond line\n\ntail\n";

  it("recovers what the paragraph replaced", () => {
    expect(parentParagraph(current, parent, 3, 4)).toBe("old claim");
    expect(replaceLines(current, 3, 4, "old claim")).toBe(parent);
  });

  it("returns an empty string for a paragraph the parent never had", () => {
    const added = "# T\n\nold claim\n\nbrand new\n\ntail\n";
    expect(parentParagraph(added, parent, 5, 5)).toBe("");
    expect(replaceLines(added, 5, 5, "")).toBe("# T\n\nold claim\n\n\ntail\n");
  });

  it("returns null when the parent still holds the paragraph unchanged", () => {
    // The moved-paragraph case: blame says this commit wrote it, but the text
    // is already in the parent, so there is nothing to revert.
    expect(parentParagraph(current, parent, 6, 6)).toBeNull();
  });
});
