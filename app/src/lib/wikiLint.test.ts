import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import type { Adjacency, LintReport } from "./ipc";
import {
  graphFindings,
  renderLintReport,
  reportFindings,
  type LintFinding,
} from "./wikiLint";

const t = STRINGS.en;
const ROOT = "/v";

const graph = (over: Partial<Adjacency>): Adjacency => ({
  forward: {},
  backward: {},
  unresolved: {},
  tags: {},
  ...over,
});

describe("graphFindings", () => {
  it("reports a page nothing links to as an orphan", () => {
    const out = graphFindings(ROOT, ["/v/wiki/a.md", "/v/wiki/b.md"], graph({
      forward: { "/v/wiki/a.md": ["/v/wiki/b.md"] },
      backward: { "/v/wiki/b.md": ["/v/wiki/a.md"] },
    }));
    expect(out).toEqual([
      { level: "info", page: "wiki/a.md", kind: "orphan_page", detail: "" },
    ]);
  });

  it("reports unresolved wikilinks but not the malformed placeholders", () => {
    const out = graphFindings(
      ROOT,
      [],
      graph({
        unresolved: {
          "/v/wiki/a.md": ["source-<slug>", "Real Missing Page", "..."],
        },
      }),
    );
    expect(out).toEqual([
      {
        level: "warning",
        page: "wiki/a.md",
        kind: "unresolved_link",
        detail: "[[Real Missing Page]]",
      },
    ]);
  });

  it("skips machine-written and non-wiki files on the unresolved side", () => {
    // daily/ is the shared classifier's territory — its `[[TASK_DONE]]` ghosts
    // are exactly the noise that swamped the first extractive reflect.
    // cards/ and work/feedback/ pass the classifier but are not wiki pages,
    // and swamped the Info tier of this report's first run.
    const out = graphFindings(
      ROOT,
      ["/v/cards/deck.md", "/v/work/feedback/2026-08-10-x.md", "/v/CLAUDE.md"],
      graph({
        unresolved: {
          "/v/daily/2026-08-01.md": ["TASK_DONE"],
          "/v/cards/deck.md": ["Nowhere"],
        },
      }),
    );
    expect(out).toEqual([]);
  });
});

describe("reportFindings", () => {
  it("keeps the Rust report's tiers", () => {
    const report: LintReport = {
      critical: [
        { page: "wiki/a.md", kind: "dangling_citation", detail: "no raw/x.md" },
      ],
      warning: [
        { page: "wiki/b.md", kind: "weak_confidence", detail: "high with 1" },
      ],
      info: [{ page: "wiki/c.md", kind: "stale_page", detail: "40 days" }],
    };
    expect(reportFindings(report).map((f) => f.level)).toEqual([
      "critical",
      "warning",
      "info",
    ]);
  });
});

describe("renderLintReport", () => {
  const findings: LintFinding[] = [
    {
      level: "info",
      page: "wiki/z.md",
      kind: "orphan_page",
      detail: "",
    },
    {
      level: "critical",
      page: "wiki/b.md",
      kind: "missing_frontmatter",
      detail: "no YAML frontmatter",
    },
    {
      level: "critical",
      page: "wiki/a.md",
      kind: "dangling_citation",
      detail: "[^src-ghost] has no raw/ghost.md",
    },
    {
      level: "warning",
      page: "wiki/c.md",
      kind: "unresolved_link",
      detail: "[[Nowhere]]",
    },
  ];

  it("renders Critical/Warning/Info with paths and our own fix hints", () => {
    expect(renderLintReport(findings, t)).toBe(
      [
        "# Wiki lint — local pass",
        "",
        `_${t.lint_local_note}_`,
        "",
        "## Critical (2)",
        "",
        "- `wiki/a.md`: [^src-ghost] has no raw/ghost.md",
        `  ↳ ${t.lint_k_dangling_citation}`,
        "- `wiki/b.md`: no YAML frontmatter",
        `  ↳ ${t.lint_k_missing_frontmatter}`,
        "",
        "## Warning (1)",
        "",
        "- `wiki/c.md`: [[Nowhere]]",
        `  ↳ ${t.lint_k_unresolved_link}`,
        "",
        "## Info (1)",
        "",
        "- `wiki/z.md`",
        `  ↳ ${t.lint_k_orphan_page}`,
      ].join("\n"),
    );
  });

  it("is deterministic regardless of finding order", () => {
    expect(renderLintReport([...findings].reverse(), t)).toBe(
      renderLintReport(findings, t),
    );
  });

  it("says so when the vault is clean", () => {
    expect(renderLintReport([], t)).toContain(t.lint_local_clean!);
  });
});
