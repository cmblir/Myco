// Weekly/monthly previews retain revision-bound evidence and historical changes.
// Sources move only after every bounded chunk has a durable receipt.

import { ipc } from "./ipc";
import type { ArchiveOptions } from "./ipc";
import { requirePublicationOrigin } from "./distillPublication";
import type { RoleSnapshot, RoleUsage } from "./modelRoles";
import HEADS from "./mycoPromptHeads.json";
import { appendEvidenceDigest, evidenceArchiveOptions, evidenceArchiveIssues, evidencePreview, readDigestNote } from "./sessionDigest";
import { completedEvidenceSources, nextEvidenceBatch, sourceEvidence, type EvidenceSource } from "./sessionEvidence";
import { getLocalOrganizeModel } from "./localTransform";
import { WorkflowOperationError, workflowIssue, workflowStatus, type WorkflowProgress, type WorkflowIssue } from "./workflowOutcome";

export interface RollupOutcome extends WorkflowProgress {
  bucketsRolledUp: number;
  sourcesArchived: number;
  skipped: "nothing" | null;
  mode: "llm" | "extractive";
  sourcesPending?: number;
  chunksProcessed?: number;
  summaryFallbacks?: number;
}

export const ROLLUP_SYSTEM =
  `${HEADS.weeklyRollup} Compress them into the week's decisions, facts and outcomes. ` +
  "Output 3-10 markdown bullets with source chunk IDs. Preserve dates, earlier states " +
  "and later changes, without treating a proposal as executed. Mark uncertain items with '(uncertain)'.";

export const MONTHLY_SYSTEM =
  `${HEADS.monthlyRollup} Compress them into the month's decisions, facts and outcomes. ` +
  "Output 3-10 markdown bullets with source chunk IDs. Preserve dates, earlier states " +
  "and later changes, without treating a proposal as executed. Mark uncertain items with '(uncertain)'.";

interface RollupLayerSpec {
  layer: "weekly" | "monthly";
  out: "weekly" | "monthly";
  sourceLabel: string;
  header: string;
  system: string;
}

const WEEKLY_LAYER: RollupLayerSpec = {
  layer: "weekly", out: "weekly", sourceLabel: "daily digests",
  header: "## Weekly rollup", system: ROLLUP_SYSTEM,
};
const MONTHLY_LAYER: RollupLayerSpec = {
  layer: "monthly", out: "monthly", sourceLabel: "weekly rollups",
  header: "## Monthly rollup", system: MONTHLY_SYSTEM,
};

/** A rollup is an additional view, not authority to forget a previous state. */
async function runRollup(vaultPath: string, spec: RollupLayerSpec, usage: RoleUsage = "foreground", capturedRole?: RoleSnapshot): Promise<RollupOutcome> {
  const origin = await ipc.agentVaultSession();
  requirePublicationOrigin(origin, vaultPath);
  const roleSnapshot = capturedRole ?? await ipc.captureModelRole(origin, "organization", usage);
  const { providerId: provider, modelId: model } = roleSnapshot.routeSignature;
  const localModelId = await getLocalOrganizeModel({ provider, model });
  const extractive = provider === "builtin-local" && !localModelId;
  const mode = extractive ? "extractive" as const : "llm" as const;
  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  const buckets = (await ipc.rollupableBuckets(vaultPath, spec.layer)).slice(0, cfg?.llm_digest_days ?? 3);
  if (!buckets.length) return { bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode };
  let bucketsRolledUp = 0;
  let sourcesArchived = 0;
  let sourcesPending = 0;
  let chunksProcessed = 0;
  let summaryFallbacks = 0;
  const issues: WorkflowIssue[] = [];
  for (const [index, { bucket, files }] of buckets.entries()) {
    let archived = 0;
    let pendingCounted = 0;
    try {
      const existing = await readDigestNote(`${vaultPath}/${spec.out}/${bucket}.md`);
      const sources: EvidenceSource[] = [];
      const originals = new Map<string, string>();
      for (const path of files) {
        const raw = (await ipc.readFile(`${vaultPath}/${path}`)).raw;
        sources.push(sourceEvidence(path, raw, bucket));
        if (localModelId) originals.set(path, raw);
      }
      const batch = nextEvidenceBatch(sources, existing);
      const priorComplete = completedEvidenceSources(sources, existing);
      let completeSources = priorComplete;
      let options: ArchiveOptions;
      if (batch.length || priorComplete.length !== sources.length) {
        const preview = await evidencePreview(batch, vaultPath, spec.system, extractive, { localModelId, originals, origin, roleSnapshot, usage });
        const appended = await appendEvidenceDigest({
          vaultPath, origin, directory: spec.out, bucket, header: spec.header,
          sourceLabel: spec.sourceLabel, sources, batch, preview: preview.text,
          extractive: preview.extractive, markerOpen: "<!-- myco:rolled-up-days ",
          localPreview: preview.localPreview, roleSnapshot,
        });
        completeSources = appended.complete;
        options = appended.options;
        chunksProcessed += batch.length;
        summaryFallbacks += Number(preview.fallback);
        if (!appended.created) throw new WorkflowOperationError("pending", "unavailable", "Existing rollup was updated; native creation authority is unavailable, so sources remain for manual recovery");
      } else options = await evidenceArchiveOptions(origin, spec.out, bucket, completeSources, existing);
      pendingCounted = sources.length - completeSources.length;
      sourcesPending += pendingCounted;
      const receipt = await ipc.archiveRolled(vaultPath, spec.layer, bucket,
        completeSources.map(source => source.path), completeSources.map(source => source.revision), options);
      sourcesArchived += receipt.moved.length;
      archived = receipt.moved.length;
      const blocked = evidenceArchiveIssues(receipt, spec.layer);
      sourcesPending += blocked.length;
      pendingCounted += blocked.length;
      issues.push(...blocked);
      bucketsRolledUp++;
      if (blocked.length) {
        sourcesPending += buckets.slice(index + 1).reduce((count, next) => count + next.files.length, 0);
        break;
      }
    } catch (error) {
      console.error(`[distill] ${spec.layer} rollup failed`, vaultPath, bucket, error);
      const issue = workflowIssue(spec.layer, error, bucket);
      issues.push(issue);
      sourcesPending += files.length - archived - pendingCounted + buckets.slice(index + 1).reduce((count, next) => count + next.files.length, 0);
      break;
    }
  }
  return { bucketsRolledUp, sourcesArchived, skipped: null, mode,
    ...(issues.length || sourcesPending ? { status: workflowStatus(issues, bucketsRolledUp + sourcesArchived + chunksProcessed, sourcesPending) } : {}),
    ...(issues.length ? { issues } : {}),
    ...(sourcesPending ? { sourcesPending } : {}),
    ...(chunksProcessed ? { chunksProcessed } : {}),
    ...(summaryFallbacks ? { summaryFallbacks } : {}),
  };
}

export function runWeeklyRollup(vaultPath: string, usage: RoleUsage = "foreground", roleSnapshot?: RoleSnapshot): Promise<RollupOutcome> {
  return runRollup(vaultPath, WEEKLY_LAYER, usage, roleSnapshot);
}

export function runMonthlyRollup(vaultPath: string, usage: RoleUsage = "foreground", roleSnapshot?: RoleSnapshot): Promise<RollupOutcome> {
  return runRollup(vaultPath, MONTHLY_LAYER, usage, roleSnapshot);
}
