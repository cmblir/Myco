import { describe, expect, it } from "vitest";
import { buildNotices, checkItems, noticeBadge, plainCheckReason, topSuspects } from "./overviewReport";
import type { NoticeInput } from "./overviewReport";
import type { RunDetail, RunSummary } from "./ipc";
import { STRINGS } from "./i18n";

describe("topSuspects", () => {
  it("returns the n pages with the most reasons first", () => {
    const r = {
      pages_checked: 3,
      suspects: [
        { page: "a.md", reasons: ["x"] },
        { page: "b.md", reasons: ["x", "y", "z"] },
        { page: "c.md", reasons: ["x", "y"] },
      ],
    };
    expect(topSuspects(r, 2).map((s) => s.page)).toEqual(["b.md", "c.md"]);
  });
});

describe("checkItems", () => {
  it("lists every page to check for see-all, as the notice rows name them", () => {
    const pages = ["a", "b", "c", "d", "e"];
    const r = {
      pages_checked: 5,
      suspects: pages.map((p) => ({ page: `${p}.md`, reasons: [`missing \`type\` ${p}`] })),
    };
    const all = checkItems(r, Infinity);
    expect(all).toHaveLength(5);
    expect(all[4]).toEqual({ rel: "wiki/e.md", reason: "missing `type` e" });
    // The notice's own rows are the first few of the same list.
    const notice = buildNotices({ ...QUIET, suspects: r }).find((n) => n.kind === "check");
    expect(notice && "items" in notice ? notice.items : []).toEqual(all.slice(0, 3));
  });
});

const run = (id: string, at: number, moves = 0, created = 0, trashed = 0): RunSummary => ({
  id,
  started_at: at,
  moves,
  trashed,
  created,
});
const detail = (id: string, d: Partial<RunDetail>): RunDetail => ({
  id,
  started_at: 0,
  moves: [],
  trashed: [],
  created: [],
  report_rel: null,
  commit: null,
  ...d,
});
const QUIET: NoticeInput = {
  runs: [],
  since: null,
  details: {},
  suspects: { pages_checked: 3, suspects: [] },
  contradictions: 0,
};

describe("buildNotices", () => {
  it("has nothing to say for a quiet, clean vault", () => {
    expect(buildNotices(QUIET)).toEqual([]);
    // Nothing loaded yet is not a notice either.
    expect(buildNotices({ ...QUIET, suspects: null })).toEqual([]);
  });

  it("counts what the runs since the last visit changed, and names a few", () => {
    const notices = buildNotices({
      ...QUIET,
      since: 1_000_000,
      runs: [run("new", 2000, 2, 1, 1), run("old", 900, 5, 5)],
      details: {
        new: detail("new", {
          created: ["daily/2026-10-01.md"],
          moves: [
            ["_inbox/a.md", "wiki/a.md"],
            ["raw/x.pdf", "raw/.archived/x.pdf"],
          ],
          trashed: [["wiki/gone.md", ".trash/gone.md"]],
        }),
      },
    });
    expect(notices).toEqual([
      {
        kind: "changes",
        count: 4,
        // Openable notes only: not the trashed page, not a raw/ file.
        items: [{ rel: "daily/2026-10-01.md" }, { rel: "wiki/a.md" }],
      },
    ]);
  });

  it("treats a first visit as away for every run, and a run that changed nothing as quiet", () => {
    expect(buildNotices({ ...QUIET, runs: [run("a", 1, 1)] })[0]).toMatchObject({
      kind: "changes",
      count: 1,
    });
    expect(buildNotices({ ...QUIET, runs: [run("a", 1)] })).toEqual([]);
    expect(buildNotices({ ...QUIET, since: 5000, runs: [run("a", 4, 3)] })).toEqual([]);
  });

  it("names at most three changed notes, each once", () => {
    const created = ["wiki/a.md", "wiki/b.md", "wiki/a.md", "wiki/c.md", "wiki/d.md"];
    const [changes] = buildNotices({
      ...QUIET,
      runs: [run("r", 1, 0, 5)],
      details: { r: detail("r", { created }) },
    });
    expect(changes).toMatchObject({
      count: 5,
      items: [{ rel: "wiki/a.md" }, { rel: "wiki/b.md" }, { rel: "wiki/c.md" }],
    });
  });

  it("lists the pages to check by count, the first few with their first problem", () => {
    const [check] = buildNotices({
      ...QUIET,
      suspects: {
        pages_checked: 9,
        suspects: [
          { page: "a.md", reasons: ["missing frontmatter"] },
          { page: "b.md", reasons: ["x", "y"] },
          { page: "sub/c.md", reasons: ["z"] },
          { page: "d.md", reasons: ["w"] },
        ],
      },
    });
    expect(check).toEqual({
      kind: "check",
      count: 4,
      items: [
        { rel: "wiki/b.md", reason: "x" },
        { rel: "wiki/a.md", reason: "missing frontmatter" },
        { rel: "wiki/sub/c.md", reason: "z" },
      ],
    });
  });

  it("names contradictions only when there are some, after the other kinds", () => {
    const notices = buildNotices({
      ...QUIET,
      runs: [run("a", 1, 1)],
      suspects: { pages_checked: 1, suspects: [{ page: "a.md", reasons: ["x"] }] },
      contradictions: 2,
    });
    expect(notices.map((n) => n.kind)).toEqual(["changes", "check", "contradictions"]);
    expect(notices[2]).toEqual({ kind: "contradictions", count: 2 });
  });
});

describe("noticeBadge", () => {
  const many = buildNotices({
    ...QUIET,
    suspects: {
      pages_checked: 104,
      suspects: Array.from({ length: 104 }, (_, i) => ({ page: `${i}.md`, reasons: ["x"] })),
    },
    contradictions: 1,
  });

  it("is none when there is nothing to report", () => {
    expect(noticeBadge([], STRINGS.ko, "ko")).toBeNull();
  });

  it("counts notice rows, not the pages behind them", () => {
    // A hundred pages to check is one thing to look at.
    expect(noticeBadge(many, STRINGS.en, "en")).toEqual({
      count: "2",
      label: "Notices: 2 to look at",
    });
  });

  // The bell and the sidebar's Home row both render this one value, so the
  // number and its spoken label cannot differ between them (decision 4).
  it("words the count the same in every language", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const badge = noticeBadge(many, STRINGS[lang], lang);
      expect(badge?.count).toBe("2");
      expect(badge?.label).toBe(STRINGS[lang].hn_label_n.replace("{n}", "2"));
    }
  });
});

describe("plainCheckReason", () => {
  const ko = STRINGS.ko;

  // Every message mcp_native::lint_page and suspect_scan can produce.
  it.each([
    ["missing frontmatter", ko.chk_no_frontmatter],
    ["missing `type`", ko.chk_no_type],
    ["invalid `type`: feature", ko.chk_bad_type],
    ["status=superseded without `superseded_by`", ko.chk_superseded],
    ["status=disputed without a `## Disputed` section", ko.chk_disputed],
    ["citation [^src-x] has no definition", ko.chk_citation],
    ["footnote [^src-y] defined but never referenced", ko.chk_footnote],
    ["source_count=2 but 3 distinct citations", ko.chk_source_count],
    ['source_count is not a number: "two"', ko.chk_source_count_nan],
    ["confidence: declared high, suggested low", ko.chk_confidence],
  ])("says %j in plain words", (raw, plain) => {
    expect(plainCheckReason(raw, ko)).toBe(plain);
  });

  it("uses the owner's own wording for the three named in the spec", () => {
    expect(ko.chk_source_count).toBe("출처 수와 인용 수가 달라요");
    expect(ko.chk_bad_type).toBe("종류(type) 값이 알 수 없는 값이에요");
    expect(ko.chk_no_frontmatter).toBe("노트 정보(머리말)가 없어요");
  });

  it("falls back to a generic line, never the raw text, for a message it does not know", () => {
    expect(plainCheckReason("something new from a later build", ko)).toBe(ko.chk_other);
    expect(plainCheckReason("", STRINGS.en)).toBe(STRINGS.en.chk_other);
  });

  it("never hands back the raw lint text, in any language", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      for (const raw of ["missing frontmatter", "source_count=2 but 3 distinct citations"]) {
        expect(plainCheckReason(raw, STRINGS[lang])).not.toContain(raw);
      }
    }
  });
});
