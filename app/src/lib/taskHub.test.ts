import { describe, expect, it, vi, beforeEach } from "vitest";

const readFile = vi.fn();
const writeFile = vi.fn();
const createFolder = vi.fn();
const listFiles = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
    listFiles: (...a: unknown[]) => listFiles(...a),
  },
}));

import {
  hubMarker,
  monthsWithTasks,
  renderTaskHub,
  writeTaskHubs,
} from "./taskHub";
import type { TaskItem } from "./ipc";

const labels = {
  heading: (m: string) => `${m} 일정`,
  empty: "_예정된 일이 없습니다._",
};

const task = (over: Partial<TaskItem>): TaskItem => ({
  page: "wiki/roadmap.md",
  stem: "roadmap",
  line: 3,
  text: "일정 정리 📅 2026-08-24",
  done: false,
  status: "todo",
  ...over,
});

beforeEach(() => {
  readFile.mockReset();
  writeFile.mockReset();
  createFolder.mockReset();
  listFiles.mockReset();
  listFiles.mockResolvedValue([]);
  createFolder.mockResolvedValue("/v/wiki/tasks");
  writeFile.mockResolvedValue(undefined);
});

describe("monthsWithTasks", () => {
  it("lists every month any date touches, sorted, without duplicates", () => {
    expect(
      monthsWithTasks([
        task({ text: "a 🛫 2026-07-30 📅 2026-08-02" }),
        task({ text: "b ⏳ 2026-09-01" }),
        task({ text: "c 📅 2026-08-24" }),
        task({ text: "d — no dates at all" }),
      ]),
    ).toEqual(["2026-07", "2026-08", "2026-09"]);
  });
});

describe("renderTaskHub", () => {
  it("groups by date range and keeps the marker and frontmatter", () => {
    const out = renderTaskHub(
      "2026-08",
      [
        task({ text: "설계 문서 쓰기 🛫 2026-08-25 📅 2026-08-28" }),
        task({ text: "리뷰 반영 📅 2026-08-24", line: 4 }),
      ],
      labels,
    );
    expect(out).toBe(
      [
        "---",
        "type: overview",
        "source_type: primary",
        "confidence: high",
        "status: active",
        "---",
        "",
        "# 2026-08 일정",
        "",
        hubMarker("2026-08"),
        "",
        "## 08-24",
        "- 리뷰 반영 — [[roadmap]]",
        "",
        "## 08-25 → 08-28",
        "- 설계 문서 쓰기 — [[roadmap]]",
        "",
      ].join("\n"),
    );
  });

  it("names a daily note as plain text — daily/ is outside the graph", () => {
    const out = renderTaskHub(
      "2026-08",
      [task({ page: "daily/2026-08-24.md", stem: "2026-08-24" })],
      labels,
    );
    expect(out).toContain("- 일정 정리 — daily/2026-08-24\n");
    expect(out).not.toContain("[[2026-08-24]]");
  });

  it("passes a task's own project link through", () => {
    const out = renderTaskHub(
      "2026-08",
      [task({ text: "리뷰 반영 [[myco-q4-roadmap]] 📅 2026-08-24" })],
      labels,
    );
    expect(out).toContain("- 리뷰 반영 [[myco-q4-roadmap]] — [[roadmap]]");
  });

  it("marks a completed task with its done date", () => {
    const out = renderTaskHub(
      "2026-08",
      [
        task({
          text: "리뷰 반영 📅 2026-08-24 ✅ 2026-08-24",
          done: true,
          status: "done",
        }),
      ],
      labels,
    );
    expect(out).toContain("- 리뷰 반영 — [[roadmap]] ✅ 2026-08-24");
  });

  it("says so explicitly when a month has nothing", () => {
    const out = renderTaskHub("2026-09", [task({})], labels);
    expect(out).toContain(labels.empty);
    expect(out).not.toContain("## ");
  });

  it("ignores a task whose dates are all in other months", () => {
    const out = renderTaskHub(
      "2026-08",
      [task({ text: "다음 달 📅 2026-09-02" })],
      labels,
    );
    expect(out).toContain(labels.empty);
  });
});

describe("writeTaskHubs", () => {
  it("writes one page per month with dated tasks", async () => {
    readFile.mockRejectedValue(new Error("missing"));
    const res = await writeTaskHubs(
      "/v",
      [task({ text: "a 📅 2026-08-24" }), task({ text: "b 📅 2026-09-02" })],
      labels,
    );
    expect(res.written).toEqual([
      "wiki/tasks/2026-08.md",
      "wiki/tasks/2026-09.md",
    ]);
    expect(createFolder).toHaveBeenCalledWith("/v/wiki", "tasks");
    expect(writeFile.mock.calls.map((c) => c[0])).toEqual([
      "/v/wiki/tasks/2026-08.md",
      "/v/wiki/tasks/2026-09.md",
    ]);
  });

  it("leaves a page whose marker is gone alone", async () => {
    readFile.mockResolvedValue({
      raw: "# my own notes\n\nI took this page over.\n",
    });
    const res = await writeTaskHubs(
      "/v",
      [task({ text: "a 📅 2026-08-24" })],
      labels,
    );
    expect(res).toEqual({ written: [], kept: ["wiki/tasks/2026-08.md"] });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rewrites a hub whose month emptied to its empty state", async () => {
    listFiles.mockResolvedValue([
      {
        kind: "directory",
        name: "wiki",
        path: "/v/wiki",
        children: [
          {
            kind: "directory",
            name: "tasks",
            path: "/v/wiki/tasks",
            children: [
              {
                kind: "file",
                name: "2026-07.md",
                path: "/v/wiki/tasks/2026-07.md",
              },
            ],
          },
        ],
      },
    ]);
    readFile.mockResolvedValue({
      raw: `# old\n\n${hubMarker("2026-07")}\n\n## 07-02\n- gone\n`,
    });
    const res = await writeTaskHubs("/v", [], labels);
    expect(res.written).toEqual(["wiki/tasks/2026-07.md"]);
    expect(writeFile.mock.calls[0][1]).toContain(labels.empty);
  });

  it("writes nothing for a month with no tasks and no page", async () => {
    readFile.mockRejectedValue(new Error("missing"));
    const res = await writeTaskHubs("/v", [], labels, ["2026-08"]);
    expect(res).toEqual({ written: [], kept: [] });
    expect(writeFile).not.toHaveBeenCalled();
  });
});
