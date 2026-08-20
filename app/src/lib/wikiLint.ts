// The wiki lint's local pass — the half of the LINT_PROMPT checklist that is
// mechanical, so builtin-local (which bundles no chat model) gets a real lint
// report instead of "no local chat model is bundled". Same move sessionDigest
// and reflectStore already made for the digest and reflect.
//
// Two sources, no third walk of the vault:
//   Rust `lint_local`  — per-page frontmatter/citation/freshness/hedge checks,
//                        one pass over the files it already has to read.
//   `build_link_graph` — orphans and unresolved [[wikilinks]], filtered by the
//                        same helpers the extractive reflect uses.
//
// Left to the LLM path: the free-form fix prose, and "concepts mentioned but
// not linked" as a semantic judgement. `wikify_candidates` is NOT that check —
// it ranks whole pages by embedding similarity to a blob of source text, which
// answers "what is this text about", not "this page names X in prose and never
// links [[X]]". Reporting it as such would be a lie, so the local pass says so
// in its header instead.

import { flattenMarkdown, isNonKnowledgePath } from "./graphData";
import { isMalformedLinkName } from "./graphGaps";
import type { Strings } from "./i18n";
import type { Adjacency, FileNode, LintReport } from "./ipc";
import { ipc } from "./ipc";

export type LintLevel = "critical" | "warning" | "info";

export interface LintFinding {
  level: LintLevel;
  /** Vault-relative path. */
  page: string;
  /** Check id — keys the localized name + fix hint (LINT_HINT_KEY). */
  kind: string;
  /** Technical specifics (English, like the validator's own `detail`), or "". */
  detail: string;
}

const rel = (vaultRoot: string, path: string): string =>
  path.startsWith(`${vaultRoot}/`) ? path.slice(vaultRoot.length + 1) : path;

/** A page this lint has anything to say about: a knowledge page (the shared
 *  classifier — daily/, weekly/, sessions/, _inbox/, raw/, ingest-reports/ and
 *  structural stems are machine-written) that lives in `wiki/`.
 *
 *  The `wiki/` half is not redundant: the classifier still admits cards/,
 *  work/feedback/ and root files like CLAUDE.md, and the first run of this
 *  report was 7/8 of its Info tier made of exactly those. It also matches the
 *  per-page half, which `validate_pages` already restricts to `wiki/` — so the
 *  whole lint covers one thing, the wiki. */
function isLintable(vaultRoot: string, path: string): boolean {
  if (isNonKnowledgePath(vaultRoot, path)) return false;
  return rel(vaultRoot, path).startsWith("wiki/");
}

/** Link-graph findings: pages nothing links to, and [[links]] with no page.
 *  Pure — the graph and the page list are handed in. `pages` are absolute
 *  paths (graph node ids), pre-filtered by the caller. */
export function graphFindings(
  vaultRoot: string,
  pages: string[],
  graph: Adjacency,
): LintFinding[] {
  const out: LintFinding[] = [];
  for (const page of [...pages].sort()) {
    if (!isLintable(vaultRoot, page)) continue;
    if ((graph.backward[page] ?? []).length === 0) {
      out.push({
        level: "info",
        page: rel(vaultRoot, page),
        kind: "orphan_page",
        detail: "",
      });
    }
  }
  for (const page of Object.keys(graph.unresolved).sort()) {
    if (!isLintable(vaultRoot, page)) continue;
    for (const target of [...graph.unresolved[page]].sort()) {
      // Template placeholders and dots-only names are not pages anyone can
      // create — the gap panel already buckets those separately.
      if (isMalformedLinkName(target)) continue;
      out.push({
        level: "warning",
        page: rel(vaultRoot, page),
        kind: "unresolved_link",
        detail: `[[${target}]]`,
      });
    }
  }
  return out;
}

/** Flatten the Rust report's three tiers into findings. */
export function reportFindings(report: LintReport): LintFinding[] {
  const tier = (level: LintLevel, issues: LintReport["critical"]) =>
    issues.map((i) => ({ level, page: i.page, kind: i.kind, detail: i.detail }));
  return [
    ...tier("critical", report.critical),
    ...tier("warning", report.warning),
    ...tier("info", report.info),
  ];
}

// Check id → the i18n key carrying its name and one-line fix hint. Our own
// fixed strings, never model prose.
const LINT_HINT_KEY: Record<string, keyof Strings> = {
  missing_frontmatter: "lint_k_missing_frontmatter",
  invalid_frontmatter: "lint_k_invalid_frontmatter",
  dangling_citation: "lint_k_dangling_citation",
  source_count_mismatch: "lint_k_source_count_mismatch",
  missing_superseded_by: "lint_k_missing_superseded_by",
  missing_disputed_section: "lint_k_missing_disputed_section",
  weak_confidence: "lint_k_weak_confidence",
  stale_page: "lint_k_stale_page",
  hedged_claim: "lint_k_hedged_claim",
  orphan_page: "lint_k_orphan_page",
  unresolved_link: "lint_k_unresolved_link",
};

const SECTION: Record<LintLevel, keyof Strings> = {
  critical: "lint_sec_critical",
  warning: "lint_sec_warning",
  info: "lint_sec_info",
};

/** Render findings as the same Markdown shape the LLM path is asked for
 *  (Critical / Warning / Info, concrete paths, one-line fixes). Deterministic:
 *  findings are sorted, so the same vault renders the same report. */
export function renderLintReport(findings: LintFinding[], t: Strings): string {
  const s = (k: keyof Strings, fallback: string): string =>
    (t[k] as string | undefined) ?? fallback;
  const head = [
    `# ${s("lint_local_title", "Wiki lint — local pass")}`,
    "",
    `_${s(
      "lint_local_note",
      "Deterministic checks only — no model was used. Free-form fixes and semantic cross-reference ideas need a connected provider.",
    )}_`,
  ];
  if (findings.length === 0) {
    return [...head, "", s("lint_local_clean", "No issues found.")].join("\n");
  }
  const out = [...head];
  for (const level of ["critical", "warning", "info"] as const) {
    const items = findings
      .filter((f) => f.level === level)
      .sort(
        (a, b) => a.page.localeCompare(b.page) || a.kind.localeCompare(b.kind),
      );
    if (items.length === 0) continue;
    out.push("", `## ${s(SECTION[level], level)} (${items.length})`, "");
    for (const f of items) {
      // `- path: detail` mirrors how ingest already prints validator issues;
      // the fix hint below it is ours and localized.
      out.push(f.detail ? `- \`${f.page}\`: ${f.detail}` : `- \`${f.page}\``);
      const key = LINT_HINT_KEY[f.kind];
      out.push(`  ↳ ${key ? s(key, f.kind) : f.kind}`);
    }
  }
  return out.join("\n");
}

/** Run the local lint over a vault and render its report. `tree` is the
 *  vault file tree the store already holds. */
export async function localLint(
  vaultRoot: string,
  tree: FileNode[],
  t: Strings,
): Promise<string> {
  const pages = flattenMarkdown(tree).filter((p) => isLintable(vaultRoot, p));
  const [report, graph] = await Promise.all([
    ipc.lintLocal(
      vaultRoot,
      pages.map((p) => rel(vaultRoot, p)),
    ),
    ipc.buildLinkGraph(vaultRoot),
  ]);
  return renderLintReport(
    [...reportFindings(report), ...graphFindings(vaultRoot, pages, graph)],
    t,
  );
}
