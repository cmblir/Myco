import { describe, expect, it } from "vitest";
import { buildRunRows } from "./runDetailView";
import type { FileDiff, RunDetail } from "./ipc";

function detail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "digest-100",
    started_at: 1755740000,
    moves: [],
    trashed: [],
    created: [],
    report_rel: null,
    commit: null,
    ...over,
  };
}

describe("buildRunRows with diffs", () => {
  it("maps each FileDiff to a row with status label key and computed diff", () => {
    const diffs: FileDiff[] = [
      {
        path: "wiki/a.md",
        status: "modified",
        before: "the floor is 0.45 now",
        after: "the floor is 0.50 now",
      },
      { path: "wiki/b.md", status: "added", before: null, after: "hello" },
    ];
    const rows = buildRunRows(detail({ commit: "abc" }), diffs);
    expect(rows.noCommit).toBe(false);
    expect(rows.files).toHaveLength(2);
    const [a, b] = rows.files;
    expect(a.rel).toBe("wiki/a.md");
    expect(a.statusKey).toBe("history_status_modified");
    expect(a.tooLarge).toBe(false);
    // word pass marked exactly the changed token
    expect(a.diff).toEqual([
      {
        kind: "del",
        segs: [
          { kind: "same", text: "the floor is " },
          { kind: "del", text: "0.45" },
          { kind: "same", text: " now" },
        ],
      },
      {
        kind: "add",
        segs: [
          { kind: "same", text: "the floor is " },
          { kind: "add", text: "0.50" },
          { kind: "same", text: " now" },
        ],
      },
    ]);
    expect(b.statusKey).toBe("history_status_added");
    expect(b.diff).toEqual([{ kind: "add", segs: [{ kind: "add", text: "hello" }] }]);
  });

  it("flags a both-sides-null file as too large with no diff", () => {
    const rows = buildRunRows(detail({ commit: "abc" }), [
      { path: "wiki/huge.md", status: "modified", before: null, after: null },
    ]);
    expect(rows.files[0].tooLarge).toBe(true);
    expect(rows.files[0].diff).toBeNull();
    expect(rows.files[0].statusKey).toBe("history_status_modified");
  });
});

describe("buildRunRows without a commit (diffs === null)", () => {
  it("builds manifest fallback rows from moves/trashed/created and sets noCommit", () => {
    const rows = buildRunRows(
      detail({
        moves: [["sessions/2026-08/a.md", "sessions/archive/2026-08/a.md"]],
        trashed: [["_inbox/junk.md", ".trash/junk.md"]],
        created: ["daily/2026-08-21.md"],
      }),
      null,
    );
    expect(rows.noCommit).toBe(true);
    expect(rows.files).toEqual([
      {
        rel: "sessions/2026-08/a.md → sessions/archive/2026-08/a.md",
        statusKey: "history_status_renamed",
        diff: null,
        tooLarge: false,
      },
      { rel: "_inbox/junk.md", statusKey: "history_status_deleted", diff: null, tooLarge: false },
      { rel: "daily/2026-08-21.md", statusKey: "history_status_added", diff: null, tooLarge: false },
    ]);
  });
});

describe("buildRunRows WHY row", () => {
  it("carries report_rel through iff present", () => {
    expect(buildRunRows(detail(), null).whyRel).toBeNull();
    expect(
      buildRunRows(detail({ report_rel: "ingest-reports/distill-digest-100.md" }), null).whyRel,
    ).toBe("ingest-reports/distill-digest-100.md");
  });
});
