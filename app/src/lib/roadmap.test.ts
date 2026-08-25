import { describe, expect, it } from "vitest";
import {
  newRoadmapContent,
  parseRoadmap,
  roadmapPages,
  roadmapSlug,
} from "./roadmap";
import type { FileNode, TaskItem } from "./ipc";

const task = (line: number, done = false): TaskItem => ({
  page: "wiki/roadmaps/q4.md",
  stem: "q4",
  line,
  text: `item ${line}`,
  done,
  status: done ? "done" : "todo",
});

describe("parseRoadmap", () => {
  const raw = [
    "---",
    "title: q4",
    "---",
    "",
    "# myco Q4 로드맵",
    "",
    "- [ ] preamble item", // line 7, above any milestone
    "",
    "## M1 — trust",
    "- [x] reader badge", // 10
    "- [ ] provenance panel", // 11
    "",
    "## M2 — resurface",
    "- [ ] reunion tuning", // 14
  ].join("\n");
  const tasks = [task(7), task(10, true), task(11), task(14)];

  it("groups items under their milestone and counts progress", () => {
    const r = parseRoadmap("wiki/roadmaps/q4.md", "q4", raw, tasks);
    expect(r.title).toBe("myco Q4 로드맵");
    expect(r.milestones.map((m) => [m.heading, m.done, m.total])).toEqual([
      ["", 0, 1],
      ["M1 — trust", 1, 2],
      ["M2 — resurface", 0, 1],
    ]);
    expect([r.done, r.total]).toEqual([1, 4]);
  });

  it("keeps an empty milestone visible rather than hiding it", () => {
    const r = parseRoadmap("p", "p", "## 비어 있음\n", []);
    expect(r.milestones).toEqual([
      { heading: "비어 있음", lines: [], done: 0, total: 0 },
    ]);
  });

  it("is 0/0 for a page with no checkboxes at all", () => {
    const r = parseRoadmap("p", "p", "# just prose\n\nno tasks here\n", []);
    expect([r.done, r.total]).toEqual([0, 0]);
    expect(r.milestones).toEqual([]);
  });
});

describe("roadmapPages", () => {
  it("lists only markdown files under wiki/roadmaps", () => {
    const tree: FileNode[] = [
      {
        kind: "directory",
        name: "wiki",
        path: "/v/wiki",
        children: [
          {
            kind: "directory",
            name: "roadmaps",
            path: "/v/wiki/roadmaps",
            children: [
              { kind: "file", name: "q4.md", path: "/v/wiki/roadmaps/q4.md" },
              {
                kind: "file",
                name: "notes.txt",
                path: "/v/wiki/roadmaps/notes.txt",
              },
            ],
          },
        ],
      },
    ];
    expect(roadmapPages(tree)).toEqual([
      { path: "wiki/roadmaps/q4.md", stem: "q4" },
    ]);
    expect(roadmapPages([])).toEqual([]);
  });
});

describe("roadmapSlug / newRoadmapContent", () => {
  it("slugs korean titles and falls back on empty", () => {
    expect(roadmapSlug("myco Q4 로드맵!")).toBe("myco-q4-로드맵");
    expect(roadmapSlug("!!!")).toBe("roadmap");
  });
  it("seeds lint-exempt frontmatter and a first milestone", () => {
    const c = newRoadmapContent("My Plan");
    expect(c).toContain("type: overview");
    expect(c).toContain("# My Plan");
    expect(c).toContain("## Milestone 1");
  });
});
