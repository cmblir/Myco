// Harvest queue (Overview → 수확대) — the pure half. The component renders;
// these decide what the selection adds up to, how the exclusion buckets are
// ordered, and what the one primary button says. Numbers only: no ipc here,
// so every rule is unit-testable in node.

import type {
  HarvestCandidate,
  HarvestCandidates,
  HarvestExcluded,
  ProvenanceRow,
} from "./ipc";

/** Exclusion buckets in the order the design lists them: the two junk
 *  buckets first (they are what makes the queue trustworthy), then the size
 *  buckets, then what a previous run already took. Fixed — the table never
 *  re-sorts by count. */
export const EXCLUDED_ORDER = [
  "duplicate",
  "boilerplate",
  "too_small",
  "too_large",
  "already_harvested",
] as const;
export type ExcludedKey = (typeof EXCLUDED_ORDER)[number];

export function excludedRows(
  ex: HarvestExcluded,
): { key: ExcludedKey; count: number }[] {
  return EXCLUDED_ORDER.map((key) => ({ key, count: ex[key] }));
}

/** The one-line "N auto-excluded" count is JUNK only — duplicates and
 *  boilerplate. Size buckets are held or below the floor, not garbage, and
 *  folding them in would overstate what the sieve threw away. */
export function junkExcluded(ex: HarvestExcluded): number {
  return ex.duplicate + ex.boilerplate;
}

export interface SelectionTotals {
  count: number;
  bytes: number;
  /** Sum of the ranker's per-session citation estimates. */
  citations: number;
}

export function selectionTotals(
  items: readonly HarvestCandidate[],
  selected: ReadonlySet<string>,
): SelectionTotals {
  let count = 0;
  let bytes = 0;
  let citations = 0;
  for (const c of items) {
    if (!selected.has(c.path)) continue;
    count++;
    bytes += c.size_bytes;
    citations += c.est_citations;
  }
  return { count, bytes, citations };
}

/** After a run the queue refills with the NEXT `limit` candidates, which
 *  reads as "nothing happened" unless the page says so. `done` is what
 *  previous runs took, `left` what is still eligible, `shown` this page.
 *  Null before the first harvest — then the never-run line is the honest one. */
export function queueProgress(
  data: Pick<HarvestCandidates, "items" | "excluded" | "eligible">,
): { done: number; left: number; shown: number } | null {
  const done = data.excluded.already_harvested;
  if (done <= 0) return null;
  return { done, left: data.eligible, shown: data.items.length };
}

/** "{n}개 수확" — the primary button and the completion toast share it. */
export function harvestLabel(template: string, n: number): string {
  return template.replace("{n}", n.toLocaleString());
}

export function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb < 100 ? kb.toFixed(1) : Math.round(kb).toLocaleString()} KB`;
}

/** Distinct `[^src-…]` sources cited anywhere in the wiki — the number the
 *  hero moves. Nine on the owner's vault the day this was measured. */
export function distinctCitations(rows: readonly ProvenanceRow[]): number {
  const slugs = new Set<string>();
  for (const r of rows) for (const s of r.sources) slugs.add(s.slug);
  return slugs.size;
}

/** Which of the three harvest surfaces the Overview owes this vault.
 *  `first-run` earns the full hero — nothing has ever been harvested, so the
 *  proposition still has to be made. `working` does not: the user has
 *  harvested before, and a 112px hero demanding the same action reads as
 *  "nothing happened", so that state collapses to one quiet row. `done` wins
 *  over `working` — an emptied queue must reach the empty state, not a row
 *  reading "0 left". No data yet (first scan, or an error) shows the hero. */
export type HarvestSurface = "first-run" | "working" | "done";

export function harvestSurface(
  data: Pick<HarvestCandidates, "items" | "excluded"> | null,
): HarvestSurface {
  if (!data) return "first-run";
  if (data.items.length === 0) return "done";
  return data.excluded.already_harvested > 0 ? "working" : "first-run";
}

/** Category colour token for a cluster page from its frontmatter `type`
 *  (link-graph meta). Untyped pages read as concepts — the live violet. */
export function clusterColorVar(type: string | undefined): string {
  switch (type) {
    case "source-summary":
      return "var(--c-source)";
    case "entity":
    case "technique":
    case "analysis":
    case "overview":
      return `var(--c-${type})`;
    default:
      return "var(--c-concept)";
  }
}
