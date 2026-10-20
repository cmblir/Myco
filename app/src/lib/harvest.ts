// Harvest queue (Overview → 수확대) — the pure half. The component renders;
// these decide what the selection adds up to, how the exclusion buckets are
// ordered, and how selected copies finish bounded evidence passes. IO is
// injected so these rules remain unit-testable in node.

import { listedName } from "./displayName";
import type {
  HarvestCandidate,
  HarvestCandidates,
  HarvestExcluded,
  HarvestRunResult,
  AgentVaultSession,
  ProvenanceRow,
} from "./ipc";
import type { InboxPassOutcome } from "./autoIngest";
import type { RoleUsage } from "./modelRoles";

export interface HarvestBatchResult {
  copied: number;
  completed: number;
  pending: number;
  skipped: HarvestRunResult["skipped"];
  failed: { path: string; reason: string }[];
  cancelled: boolean;
}

interface HarvestBatchIO {
  origin: AgentVaultSession;
  expectedVaultToken: string;
  copy: (
    paths: string[],
    vaultPath: string,
    origin: AgentVaultSession,
  ) => Promise<HarvestRunResult>;
  pass: (
    vaultPath: string,
    options: {
      sourcePath: string;
      sourceRevision: string;
      origin: AgentVaultSession;
      expectedVaultToken: string;
      usage: RoleUsage;
    },
  ) => Promise<InboxPassOutcome>;
  isCurrentVault: (vaultPath: string) => boolean;
  onProgress: (done: number, total: number) => void;
}

/** Process only this selection's copies, resuming bounded evidence batches.
 * Copying, held inputs, missing sources and partial coverage are not completion. */
export async function harvestSelected(
  vaultPath: string,
  paths: string[],
  io: HarvestBatchIO,
): Promise<HarvestBatchResult> {
  const result: HarvestBatchResult = {
    copied: 0,
    completed: 0,
    pending: 0,
    skipped: [],
    failed: [],
    cancelled: false,
  };
  if (!io.isCurrentVault(vaultPath)) return { ...result, cancelled: true };
  if (
    io.origin.vaultPath !== vaultPath ||
    !io.origin.openingToken ||
    !io.expectedVaultToken
  ) {
    throw new Error("Harvest requires its originating vault opening");
  }
  const copied = await io.copy(paths, vaultPath, io.origin);
  const targets = [...new Set(copied.inbox_rels)];
  result.copied = targets.length;
  result.pending = targets.length;
  result.skipped = copied.skipped;
  if (!io.isCurrentVault(vaultPath)) return { ...result, cancelled: true };
  io.onProgress(0, result.copied);
  let passes = 0;
  for (const rel of targets) {
    const name = rel.slice(7);
    if (
      !rel.startsWith("_inbox/") ||
      !name ||
      name.startsWith(".") ||
      name.includes("/") ||
      rel.includes("\\")
    ) {
      result.failed.push({ path: rel, reason: "invalid harvest inbox path" });
      continue;
    }
    const sourcePath = `${vaultPath.replace(/\/$/, "")}/${rel}`;
    const bindings =
      copied.inbox_sources?.filter((binding) => binding.inbox_rel === rel) ??
      [];
    const sourceRevision = bindings[0]?.source_revision;
    const sourceRels = new Set<string>();
    const validBindings =
      bindings.length > 0 &&
      bindings.every((binding) => {
        const sourceRel = binding.source_rel;
        if (
          !sourceRel ||
          sourceRel.startsWith("/") ||
          sourceRel.includes("\\") ||
          sourceRel
            .split("/")
            .some((part) => !part || part === "." || part === "..") ||
          !paths.includes(`${vaultPath.replace(/\/$/, "")}/${sourceRel}`) ||
          sourceRels.has(sourceRel) ||
          !/^[a-f0-9]{64}$/.test(binding.source_revision) ||
          binding.source_revision !== sourceRevision
        )
          return false;
        sourceRels.add(sourceRel);
        return true;
      });
    if (!validBindings || !sourceRevision) {
      result.failed.push({
        path: sourcePath,
        reason: "harvest copy lacks its exact source revision",
      });
      continue;
    }
    let previousPending = Infinity;
    for (let attempt = 0; attempt < 32 && passes < 64; attempt++) {
      if (!io.isCurrentVault(vaultPath)) return { ...result, cancelled: true };
      passes++;
      let out: InboxPassOutcome;
      try {
        out = await io.pass(vaultPath, {
          sourcePath,
          sourceRevision,
          origin: io.origin,
          expectedVaultToken: io.expectedVaultToken,
          usage: "foreground",
        });
      } catch (e) {
        result.failed.push({ path: sourcePath, reason: String(e) });
        break;
      }
      if (!io.isCurrentVault(vaultPath)) return { ...result, cancelled: true };
      if (out.error) {
        result.failed.push({ path: sourcePath, reason: out.error });
        break;
      }
      if (out.busy) return result;
      if (out.sourcePath !== sourcePath) {
        result.failed.push({
          path: sourcePath,
          reason: "harvest source was not processed",
        });
        break;
      }
      if (
        out.sourceRevision !== sourceRevision ||
        out.origin?.vaultPath !== io.origin.vaultPath ||
        out.origin.openingToken !== io.origin.openingToken
      ) {
        result.failed.push({
          path: sourcePath,
          reason: "harvest pass differs from its originating source/opening",
        });
        break;
      }
      const pendingChunks = out.pendingChunks ?? 0;
      if (
        out.ingested &&
        pendingChunks === 0 &&
        out.harvestCompleted === true
      ) {
        result.completed++;
        result.pending--;
        io.onProgress(result.completed, result.copied);
        break;
      }
      if (pendingChunks <= 0 || pendingChunks >= previousPending) break;
      previousPending = pendingChunks;
    }
    if (passes >= 64) break;
  }
  return result;
}

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

/** A cluster page (vault-relative) as a row names it: its path without
 *  `.md`, except an opaque session page, which reads as the tree lists it
 *  (its Tidy `title`, else `<Agent> · 8hex`). */
export function clusterLabel(page: string, title?: string): string {
  const stem = (page.split("/").pop() ?? page).replace(/\.md$/i, "");
  const named = listedName(stem, title);
  return named === stem ? page.replace(/\.md$/i, "") : named;
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
