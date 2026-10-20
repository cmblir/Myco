// Bounded session previews backed by complete, revision-bound quoted evidence.
// Input files stay active until every chunk has a durable coverage receipt.

import { ipc } from "./ipc";
import type { AgentVaultSession, ArchiveOptions, ArchivePublication, ArchiveReceipt, DistillPublicationReceipt } from "./ipc";
import { sha256 } from "./tidyRun";
import { complete } from "./chat";
import type { RoleSnapshot, RoleUsage } from "./modelRoles";
import HEADS from "./mycoPromptHeads.json";
import { cosine, dropNearDuplicates, renderQuoteBullets, stripFiller } from "./quoteBullets";
import { writeEvidenceNote } from "./evidenceWrite";
import { publicationClaim, publishManagedNote, requireNativeCreation, requirePublicationOrigin } from "./distillPublication";
import { STRINGS, type Lang } from "./i18n";
import { useUIStore } from "../stores/uiStore";
import { WorkflowOperationError, workflowIssue, workflowStatus, type WorkflowProgress, type WorkflowIssue } from "./workflowOutcome";
import { getLocalOrganizeModel, localTransformNote, LocalTransformSourceError, requireLocalTransformPreview, tryLocalTransform, type LocalTransformPreview } from "./localTransform";
import {
  completedEvidenceSources, evidencePrompt, evidenceSection,
  fingerprint, isMissingFile, nextEvidenceBatch, sourceEvidence, type EvidenceChunk,
  type EvidenceSource,
} from "./sessionEvidence";

export { fingerprint } from "./sessionEvidence";

export interface DigestOutcome extends WorkflowProgress {
  daysDigested: number;
  filesArchived: number;
  skipped: "nothing" | null;
  mode: "llm" | "extractive";
  /** Unfinished files remain searchable and resume on the next run. */
  filesPending?: number;
  chunksProcessed?: number;
  summaryFallbacks?: number;
}

export const DIGEST_SYSTEM =
  `${HEADS.sessionDigest} ` +
  "Output 3-10 markdown bullets, citing the supplied source chunk IDs. No preamble. " +
  "Preserve dates and historical changes; a decision mention is not proof of execution. " +
  "Mark uncertain items with '(uncertain)'.";

const HEADER = "## Session digest (auto)";
const DEFAULT_DIGEST_DAYS = 3;

interface PendingEvidencePublication { receipt: DistillPublicationReceipt; sources: string; options: ArchiveOptions }
// References to native-issued capabilities only. Restart/reopen never derives
// ownership from existing bytes or evidence markers.
const pendingPublications = new Map<string, PendingEvidencePublication>();
function publicationKey(origin: AgentVaultSession, path: string): string {
  return JSON.stringify([origin.vaultPath, origin.openingToken, path]);
}
function sourceSignature(sources: EvidenceSource[]): string {
  return JSON.stringify(sources.map(source => [source.path, source.revision]).sort((a, b) => a[0].localeCompare(b[0])));
}

/** Legacy full-file receipt, emitted only after all evidence chunks exist. */
export function fullCoverageMarker(open: string, sources: EvidenceSource[]): string {
  const entries = sources.map(source =>
    (source.path.split("/").pop() ?? source.path).replace(/\.md$/, "") + ":" + source.revision,
  );
  return open + entries.join(" ") + " -->";
}

/** Indices of up to `k` vectors, MMR-selected against the (unnormalized)
 * centroid: score = λ·cos(v, centroid) − (1−λ)·max cos(v, picked). Ties break
 * to the lowest index, i.e. document order — that is what makes the whole
 * digest deterministic. Exported for its own test. */
export function mmrSelect(vectors: number[][], k: number, lambda = 0.6): number[] {
  if (vectors.length === 0) return [];
  // Sum, not mean: cosine is scale-invariant, so dividing by n changes nothing.
  const centroid = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) centroid[i] += v[i];
  const rel = vectors.map((v) => cosine(v, centroid));
  const picked: number[] = [];
  while (picked.length < Math.min(k, vectors.length)) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < vectors.length; i++) {
      if (picked.includes(i)) continue;
      let div = 0;
      for (const j of picked) div = Math.max(div, cosine(vectors[i], vectors[j]));
      const score = lambda * rel[i] - (1 - lambda) * div;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    picked.push(best);
  }
  return picked;
}

/** Embeddings select the preview only; all chunks are retained as evidence. */
export async function extractiveEvidencePreview(batch: EvidenceChunk[], maxBullets = 8): Promise<string> {
  const units = batch.map(chunk => ({
    text: stripFiller(chunk.text.replace(/\s+/g, " ").trim()),
    label: chunk.source.split("/").pop()?.replace(/\.md$/, "") ?? chunk.source,
  })).filter(unit => unit.text.length >= 40);
  if (!units.length) return "- (see source evidence below)";
  const vectors = await ipc.embedLocalTexts(units.map(unit => unit.text));
  if (vectors.length !== units.length) throw new Error("Evidence embedding count does not match input");
  const ranked = dropNearDuplicates(mmrSelect(vectors, maxBullets * 2), vectors);
  return renderQuoteBullets(units, ranked.slice(0, maxBullets), 220);
}

/** Existing notes may be absent, but I/O errors must never erase their text. */
export async function readDigestNote(path: string): Promise<string> {
  try { return (await ipc.readFile(path)).raw; }
  catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

/** Provider output is a preview, never an authorization to discard evidence. */
export async function evidencePreview(
  batch: EvidenceChunk[], vaultPath: string, system: string, extractive: boolean,
  options: { localModelId?: string; lang?: Lang; signal?: AbortSignal; originals?: ReadonlyMap<string, string>; origin?: AgentVaultSession; roleSnapshot?: RoleSnapshot; usage?: RoleUsage } = {},
): Promise<{ text: string; extractive: boolean; fallback: boolean; localPreview?: LocalTransformPreview }> {
  if (!batch.length) return { text: "", extractive, fallback: false };
  if (options.localModelId) {
    const lang = options.lang ?? useUIStore.getState().lang;
    const local = await tryLocalTransform({ batch, vaultPath, kind: "organize", modelId: options.localModelId,
      lang, signal: options.signal, originals: options.originals, origin: options.origin, roleSnapshot: options.roleSnapshot });
    if (local) {
      // Native verifies its preview subset. Durable quotes also need the
      // revisions of the other source files in this bounded 48-chunk batch.
      const revisions = new Map(batch.map(chunk => [chunk.source, chunk.revision]));
      for (const [page, revision] of revisions) {
        if (options.signal?.aborted) throw new Error("stopped");
        let raw: string;
        try { raw = (await ipc.readFile(`${vaultPath}/${page}`)).raw; }
        catch { throw new LocalTransformSourceError("source_verification_failed"); }
        if (fingerprint(raw) !== revision) throw new LocalTransformSourceError("source_changed_during_generation");
      }
      if (options.signal?.aborted) throw new Error("stopped");
      requireLocalTransformPreview(local);
      return { text: `_${localTransformNote(local, STRINGS[lang])}_\n\n${local.text}`,
        extractive: false, fallback: false, localPreview: local };
    }
    throw new WorkflowOperationError("pending", "unavailable", "Selected local preview could not be prepared; source remains pending");
  }
  if (extractive) return { text: await extractiveEvidencePreview(batch), extractive: true, fallback: false };
  const text = await complete({
      task: "generate", featureRole: "organization", usage: options.usage, origin: options.origin, roleSnapshot: options.roleSnapshot, cwd: vaultPath,
      messages: [{ role: "system", content: system }, { role: "user", content: evidencePrompt(batch) }],
    });
    if (!text.trim() || !/^[-*] .+/m.test(text) || text.length > 20_000) {
      throw new Error("Digest preview did not contain valid markdown bullets");
    }
  return { text, extractive: false, fallback: false };
}

/** Rebuild an append after a cooperating editor save changes the note.
 * Complete-file markers and partial receipts share the same conditional write. */
export async function appendEvidenceDigest(args: {
  vaultPath: string; origin: AgentVaultSession; directory: "daily" | "weekly" | "monthly"; bucket: string; header: string;
  sourceLabel: string; sources: EvidenceSource[]; batch: EvidenceChunk[];
  preview: string; extractive: boolean; markerOpen: string;
  localPreview?: LocalTransformPreview; roleSnapshot?: RoleSnapshot;
}): Promise<{ created: boolean; complete: EvidenceSource[]; publication: ArchivePublication; options: ArchiveOptions }> {
  const { vaultPath, directory, bucket, sources, batch } = args;
  requirePublicationOrigin(args.origin, vaultPath);
  const filePath = `${vaultPath}/${directory}/${bucket}.md`;
  let receipt: DistillPublicationReceipt | undefined;
  const timestamp = new Date().toISOString();
  const written = await writeEvidenceNote({
    readFile: ipc.readFile,
    writeFileIfUnchanged: async (_path, content, expected) => {
      const complete = completedEvidenceSources(sources, content);
      const operationId = await evidenceOperationId(args.origin, directory, bucket, complete, `${directory}/${bucket}.md`, await sha256(content));
      receipt = await publishManagedNote(args.origin, operationId, { kind: directory, key: bucket }, content, expected, args.roleSnapshot);
    },
  }, filePath, current => {
    const existing = current || `# ${bucket}\n\n`;
    const evidence = evidenceSection(sources, batch);
    const completeSources = completedEvidenceSources(sources, existing + evidence);
    const marker = completeSources.length ? fullCoverageMarker(args.markerOpen, completeSources) : "";
    const label = args.localPreview ? "low confidence" : args.extractive ? "extractive quotes (no LLM)" : "low confidence";
    const opening = existing.includes(args.header)
      ? `\n_run of ${timestamp}${args.extractive && !args.localPreview ? " (extractive)" : ""}_\n`
      : `\n${args.header}\n_from ${sources.length} ${args.sourceLabel} — ${label}_\n`;
    const content = existing + opening + marker + "\n" + args.preview.trim() + "\n" + evidence;
    return { content, result: { complete: completeSources } };
  });
  if (!receipt) throw new WorkflowOperationError("pending", "validation_rejected", "Missing native publication receipt; manual recovery required");
  const options: ArchiveOptions = { origin: args.origin, manifestId: receipt.operationId,
    publications: [publicationClaim(receipt)], publicationIds: [receipt.publicationId] };
  pendingPublications.set(publicationKey(args.origin, receipt.path), { receipt, options, sources: sourceSignature(written.complete) });
  return { created: receipt.nativeCreated, complete: written.complete, publication: publicationClaim(receipt), options };
}

/** Compute the operation before the native write; it does not grant ownership. */
async function evidenceOperationId(origin: AgentVaultSession, layer: string, bucket: string,
  sources: EvidenceSource[], path: string, revision: string): Promise<string> {
  const digest = await sha256(JSON.stringify([origin.vaultPath, layer, bucket,
    sources.map(source => [source.path, source.revision]).sort((a, b) => a[0].localeCompare(b[0])),
    path, revision]));
  return `llm-${BigInt(`0x${digest.slice(0, 15)}`).toString()}`;
}

/** Retry only a capability retained from this process and original opening. */
export async function evidenceArchiveOptions(origin: AgentVaultSession, layer: string, bucket: string,
  sources: EvidenceSource[], existing: string): Promise<ArchiveOptions> {
  requirePublicationOrigin(origin, origin.vaultPath);
  const pending = pendingPublications.get(publicationKey(origin, `${layer}/${bucket}.md`));
  requireNativeCreation(pending?.receipt);
  if (!pending || pending.sources !== sourceSignature(sources) || pending.receipt.revision !== await sha256(existing)) {
    throw new WorkflowOperationError("pending", "unavailable", "Publication changed or archive input differs; preserve artifacts for manual recovery");
  }
  return pending.options;
}

/** Native declined moves stay pending; requested files are never completion proof. */
export function evidenceArchiveIssues(receipt: ArchiveReceipt, step: string): WorkflowIssue[] {
  return [...receipt.pending, ...receipt.skipped].map(item => ({
    step, item: item.path, status: "pending", code: "incomplete", error: item.reason, retryable: receipt.retryable,
  }));
}

/** Each run handles at most 48 chunks per day, retaining every quoted chunk.
 * Legacy whole-file markers are rechecked rather than trusted as coverage. */
export async function runSessionDigest(vaultPath: string, usage: RoleUsage = "foreground", capturedRole?: RoleSnapshot): Promise<DigestOutcome> {
  const origin = await ipc.agentVaultSession();
  requirePublicationOrigin(origin, vaultPath);
  const roleSnapshot = capturedRole ?? await ipc.captureModelRole(origin, "organization", usage);
  const { providerId: provider, modelId: model } = roleSnapshot.routeSignature;
  const localModelId = await getLocalOrganizeModel({ provider, model });
  const extractive = provider === "builtin-local" && !localModelId;
  const mode = extractive ? "extractive" as const : "llm" as const;
  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  const days = (await ipc.digestableSessionDays(vaultPath)).slice(0, cfg?.llm_digest_days ?? DEFAULT_DIGEST_DAYS);
  if (!days.length) return { daysDigested: 0, filesArchived: 0, skipped: "nothing", mode };
  let daysDigested = 0;
  let filesArchived = 0;
  let filesPending = 0;
  let chunksProcessed = 0;
  let summaryFallbacks = 0;
  const issues: WorkflowIssue[] = [];
  for (const [index, { day, files }] of days.entries()) {
    let archived = 0;
    let pendingCounted = 0;
    try {
      const existing = await readDigestNote(`${vaultPath}/daily/${day}.md`);
      const sources: EvidenceSource[] = [];
      const originals = new Map<string, string>();
      // Sequential reads avoid loading unrelated days in parallel on 8 GB hosts.
      for (const path of files) {
        const raw = (await ipc.readFile(`${vaultPath}/${path}`)).raw;
        sources.push(sourceEvidence(path, raw, day));
        if (localModelId) originals.set(path, raw);
      }
      const batch = nextEvidenceBatch(sources, existing);
      const priorComplete = completedEvidenceSources(sources, existing);
      let completeSources = priorComplete;
      let options: ArchiveOptions;
      if (batch.length || priorComplete.length !== sources.length) {
        const preview = await evidencePreview(batch, vaultPath, DIGEST_SYSTEM, extractive, { localModelId, originals, origin, roleSnapshot, usage });
        const appended = await appendEvidenceDigest({
          vaultPath, origin, directory: "daily", bucket: day, header: HEADER,
          sourceLabel: "session logs", sources, batch, preview: preview.text,
          extractive: preview.extractive, markerOpen: "<!-- myco:digested-sessions ",
          localPreview: preview.localPreview, roleSnapshot,
        });
        completeSources = appended.complete;
        options = appended.options;
        chunksProcessed += batch.length;
        summaryFallbacks += Number(preview.fallback);
        if (!appended.created) throw new WorkflowOperationError("pending", "unavailable", "Existing digest was updated; native creation authority is unavailable, so sources remain for manual recovery");
      } else options = await evidenceArchiveOptions(origin, "daily", day, completeSources, existing);
      pendingCounted = sources.length - completeSources.length;
      filesPending += pendingCounted;
      const receipt = await ipc.archiveDigestedSessions(vaultPath, day,
        completeSources.map(source => source.path), completeSources.map(source => source.revision), options);
      filesArchived += receipt.moved.length;
      archived = receipt.moved.length;
      const blocked = evidenceArchiveIssues(receipt, "digest");
      filesPending += blocked.length;
      pendingCounted += blocked.length;
      issues.push(...blocked);
      daysDigested++;
      if (blocked.length) {
        filesPending += days.slice(index + 1).reduce((count, next) => count + next.files.length, 0);
        break;
      }
    } catch (error) {
      console.error("[distill] session digest failed", vaultPath, day, error);
      const issue = workflowIssue("digest", error, day);
      issues.push(issue);
      filesPending += files.length - archived - pendingCounted + days.slice(index + 1).reduce((count, next) => count + next.files.length, 0);
      break;
    }
  }
  return { daysDigested, filesArchived, skipped: null, mode,
    ...(issues.length || filesPending ? { status: workflowStatus(issues, daysDigested + filesArchived + chunksProcessed, filesPending) } : {}),
    ...(issues.length ? { issues } : {}),
    ...(filesPending ? { filesPending } : {}),
    ...(chunksProcessed ? { chunksProcessed } : {}),
    ...(summaryFallbacks ? { summaryFallbacks } : {}),
  };
}
