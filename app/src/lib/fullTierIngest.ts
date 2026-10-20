// Full-tier ingest execution (Phase B, Task 3). The distill gate's ontology
// admission pass (Rust `ontology::admit`, via `scan`) tags some items
// `Tier::Full` — worth a real LLM ingest, not just a one-line
// digest. This module drains that ledger through the SAME prompt + provider
// machinery interactive Ingest uses (`INGEST_PROMPT` + `runIngestProvider`,
// both exported from ingestStore.ts) rather than a second hand-maintained
// implementation, budgeted so one automatic pass cannot run away with LLM
// spend.
//
// Headless providers receive the original Compilation grant; unavailable
// transports remain pending instead of bypassing the native admission.

import { ipc, type AgentVaultSession, type SessionCompileContext, type SessionCompileStepResult } from "./ipc";
import type { RoleSnapshot, RoleUsage } from "./modelRoles";
import { stripFrontmatter } from "./markdown";
import { loadProfile } from "./profile";
import { INGEST_PROMPT, runIngestProvider } from "../stores/ingestStore";
import { sha256 } from "./tidyRun";
import { log } from "./log";
import { sessionIdentity } from "./sessionIdentity";
import { sessionTitle } from "./sessionTitle";
import { runNativeSessionCompile } from "./sessionCompileIO";
import { useUIStore } from "../stores/uiStore";
import { WorkflowOperationError, workflowIssue, workflowStatus, type WorkflowProgress, type WorkflowIssue } from "./workflowOutcome";

export interface FullTierOutcome extends WorkflowProgress {
  ingested: number;
  skipped: "no-provider" | "nothing" | null;
  errors: string[];
  sourcesPending?: number;
  /** Confirmed persisted session artifacts, independent of compiler success. */
  publishedSources?: number;
}

// Fallback llm_ingest_budget when getDistillConfig is unavailable — mirrors
// DistillConfig's Rust-side default (distill.rs's d_ingest_budget), same
// fallback idiom as sessionDigest.ts's DEFAULT_DIGEST_DAYS.
const DEFAULT_INGEST_BUDGET = 3;

/** First ATX heading (`#`..`######`) in `content`, else `fallback` — TS-side
 * equivalent of distill.rs's strip_atx_heading. Frontmatter is stripped
 * first (reusing markdown.ts's own helper): a real `_inbox/` import always
 * opens with a YAML block, and a `#`-led line inside it (a YAML comment, not
 * a heading) would otherwise be mismatched as the title. Scans only the
 * first 40 lines of the body — the title is always near the top, and this
 * bounds the regex scan on a pathologically long source. */
function titleFromContent(content: string, fallback: string): string {
  const body = stripFrontmatter(content).split("\n").slice(0, 40).join("\n");
  const m = body.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function stemOf(rel: string): string {
  return rel.split("/").pop()!.replace(/\.md$/, "");
}

/** DTO consistency only; native admission and each use prove authority. */
function checkedCompilationRole(origin: AgentVaultSession, role: RoleSnapshot, usage: RoleUsage): RoleSnapshot {
  if (!origin?.openingToken || !role || role.role !== "compilation" || role.usage !== usage ||
      role.origin?.vaultPath !== origin.vaultPath || role.origin.openingToken !== origin.openingToken ||
      role.routeSignature?.role !== "compilation" || !role.routeSignature.providerId) {
    throw new WorkflowOperationError("pending", "validation_rejected", "Compilation grant does not match this job");
  }
  return role;
}

function compilationAdmissionError(error: unknown): unknown {
  if (error instanceof WorkflowOperationError) return error;
  const message = String(error);
  if (/snapshot_stale|origin_mismatch|active vault changed|vault opening was superseded/i.test(message)) {
    return new WorkflowOperationError("stopped", "cancelled", message);
  }
  if (/automatic_external_not_permitted|route_unconfirmed|connection_unavailable|capability_unavailable/i.test(message)) {
    return new WorkflowOperationError("pending", "unavailable", message);
  }
  return error;
}

/** Runs the existing ingest pipeline over every gate-admitted Full-tier item
 * (`ipc.fullTierItems`, oldest first), up to `llm_ingest_budget` items —
 * the per-run LLM-cost cap, same idea as `runSessionDigest`'s
 * `llm_digest_days`. Called from `runDistillGuarded` after the session
 * digest, inside the same guard window.
 *
 * `_inbox/` items are skipped (owner decision 2026-10-03, B1): `INGEST_PROMPT`
 * reads `raw/${slug}.md`, so ingesting one meant first writing a copy into
 * raw/, and no run writes into raw/. They are dropped before the budget slice
 * so they cannot starve the raw/ items, which are only read here.
 *
 * No retry: an item whose read/ingest throws is recorded in `errors`
 * and the loop moves to the next one. The next scan/ingest pass offers it
 * again on its own (same ledger tier, unchanged content hash).
 *
 * A successful provider exit is only a draft: the actual pages are read and
 * validated before a source revision can receive a completion receipt. */
export async function runFullTierIngest(
  vaultPath: string,
  options: { pendingOnly?: boolean; origin?: AgentVaultSession; roleSnapshot?: RoleSnapshot; usage?: RoleUsage; signal?: AbortSignal;
    onSessionStarted?: (context: SessionCompileContext) => void;
    onSessionProgress?: (context: SessionCompileContext, result: SessionCompileStepResult) => void } = {},
): Promise<FullTierOutcome> {
  // Emptiness is checked BEFORE the provider: "waiting for a provider" with
  // an empty queue is a lie the Overview card would faithfully repeat — a
  // vault with nothing to promote reports "nothing" whatever the provider.
  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  const budget = options.pendingOnly ? 1 : cfg?.llm_ingest_budget ?? DEFAULT_INGEST_BUDGET;
  const usage = options.usage ?? "foreground";
  let origin = options.origin ?? options.roleSnapshot?.origin ?? (options.pendingOnly ? await ipc.agentVaultSession() : undefined);
  if (origin && origin.vaultPath !== vaultPath) throw new Error("the active vault changed before session compilation");
  const pending = options.pendingOnly ? await ipc.listWikifyPending(vaultPath, origin!, budget) : null;
  const items = (pending ? pending.items.map(item => item.rawPath) : await ipc.fullTierItems(vaultPath))
    .filter((rel) => !rel.startsWith("_inbox/"))
    .slice(0, budget);
  if (items.length === 0) {
    return { ingested: 0, skipped: "nothing", errors: [] };
  }

  // Canonical sessions issue a source-bound attempt. Ordinary documents share
  // one Compilation grant; legacy display settings never select their route.
  const hasOrdinarySources = items.some(rel => !rel.startsWith("raw/conversations/"));
  let ordinaryRole = options.roleSnapshot;
  if (hasOrdinarySources || ordinaryRole) {
    try {
      origin ??= await ipc.agentVaultSession();
      if (origin.vaultPath !== vaultPath) throw new Error("the active vault changed before session compilation");
      ordinaryRole = checkedCompilationRole(origin,
        ordinaryRole ?? await ipc.captureModelRole(origin, "compilation", usage), usage);
    } catch (error) {
      const failure = compilationAdmissionError(error);
      const issues = items.map(item => workflowIssue("ingest", failure, item));
      return { ingested: 0, skipped: null, errors: items.map(item => `${item}: ${String(failure)}`),
        sourcesPending: items.length, status: workflowStatus(issues, 0, items.length), issues };
    }
  }
  const provider = ordinaryRole?.routeSignature.providerId ?? "builtin-local";
  const model = ordinaryRole?.routeSignature.modelId ?? "";
  let ordinaryProviderConnected = true;
  if (provider === "myco-pro") {
    const settings = await ipc.getSettings();
    ordinaryProviderConnected = settings.providers.myco_pro === true;
    if (!ordinaryProviderConnected && items.every(rel => !rel.startsWith("raw/conversations/"))) {
      return { ingested: 0, skipped: "no-provider", errors: [], sourcesPending: items.length,
        status: "pending", issues: [workflowIssue("ingest", new WorkflowOperationError("pending", "unavailable", "Selected provider is not connected"))] };
    }
  }

  // Phase B, Task 6 — same grounding line startIngest passes, computed once
  // for the whole run rather than per item (the profile does not change
  // mid-run), and gated on the same `profile_injection` toggle for the same
  // reason (see startIngest's comment): this line is still profile content
  // sent to a provider. `cfg` above already failed CLOSED (`?? null` on a
  // read error) — no profile, no interests line.
  const profile = cfg?.profile_injection && ordinaryProviderConnected ? await loadProfile(vaultPath) : null;
  const profileInterests = profile?.interests.join(", ") ?? "";

  let ingested = 0;
  let sourcesPending = 0;
  let partialSession = false;
  const errors: string[] = [];
  const issues: WorkflowIssue[] = [];
  for (const [index, rel] of items.entries()) {
    let hasDelegatedOutcome = false;
    try {
      if (!ordinaryProviderConnected && !rel.startsWith("raw/conversations/")) {
        throw new WorkflowOperationError("pending", "unavailable", "Selected provider is not connected");
      }
      const content = (await ipc.readFile(`${vaultPath}/${rel}`)).raw;
      const identity = rel.startsWith("raw/conversations/") ? await sessionIdentity(content) : null;
      const pendingSource = pending?.items.find(item => item.rawPath === rel);
      if (pending && (!pendingSource || !identity || pendingSource.key !== identity.key ||
          pendingSource.sourceRevision !== await sha256(content))) {
        throw new Error("pending session identity or source revision does not match; reload the import queue");
      }
      if (rel.startsWith("raw/conversations/")) {
        if (!identity) throw new Error("pending session identity or source revision does not match; reload the import queue");
        const boundOrigin = origin ?? await ipc.agentVaultSession();
        if (boundOrigin.vaultPath !== vaultPath) throw new Error("the active vault changed before session compilation");
        let context: SessionCompileContext | undefined;
        try {
          context = await ipc.sessionCompileBegin(boundOrigin, { key: identity.key, rawPath: rel,
            sourceRevision: await sha256(content) }, usage);
          checkedCompilationRole(boundOrigin, context.roleSnapshot, usage);
          options.onSessionStarted?.(context);
          const route = context.roleSnapshot.routeSignature;
          if (route.providerId !== "builtin-local") {
            throw new WorkflowOperationError("pending", "unavailable", "Selected external session compiler adapter is unavailable; source remains pending");
          }
          const issued = context;
          hasDelegatedOutcome = true;
          const completion = await runNativeSessionCompile(issued, {
            lang: useUIStore.getState().lang, signal: options.signal,
            onProgress: result => options.onSessionProgress?.(issued, result),
          });
          if (completion.state === "completed") ingested++;
          else {
            sourcesPending++;
            partialSession = true;
            issues.push(workflowIssue("session-compile", new WorkflowOperationError("pending", "validation_rejected",
              "Original-source compilation review was not accepted for every packet"), rel));
          }
        } catch (error) {
          const stopped = error instanceof WorkflowOperationError && error.status === "stopped";
          const unavailableExternal = error instanceof WorkflowOperationError && error.status === "pending" &&
            error.code === "unavailable" && context?.roleSnapshot.routeSignature.providerId !== "builtin-local";
          if (context && !hasDelegatedOutcome && (stopped || unavailableExternal)) {
            try { await ipc.sessionCompileStop(context, stopped ? "stopped" : "preparation_required"); }
            catch (stopError) {
              throw new Error(`${String(error)}; native attempt outcome could not be saved: ${String(stopError)}`);
            }
          }
          if (!context && String(error).includes("SEMANTIC_ADAPTER_REQUIRED")) {
            throw new WorkflowOperationError("pending", "unavailable", String(error));
          }
          throw hasDelegatedOutcome ? error : compilationAdmissionError(error);
        }
        continue;
      }
      const before = new Map(await ipc.fileMtimes(vaultPath));
      // Sessions were dispatched above through their native canonical attempt.
      const slug = stemOf(rel);
      const source = rel.replace(/^raw\//, "").replace(/\.md$/i, "");
      const title = sessionTitle(content) ?? titleFromContent(content, slug);
      const summary = `wiki/source-${slug}.md`;
      // Same grounding the manual ingest path builds (ingestStore:
      // wikifyCandidates → groundingBlock): without it the headless pass told
      // the LLM nothing about existing pages, so voice notes and promoted
      // sessions grew fresh near-duplicate pages instead of updating the page
      // they echo. Best-effort — an empty list just omits the block.
      const candidates = await ipc.wikifyCandidates(content.trim(), 8).catch((error) => {
        log.warn("full_tier.grounding_failed", { error: String(error) });
        return [];
      });
      const prompt = INGEST_PROMPT(source, title, candidates, [], profileInterests, slug, summary, identity?.key);
      let chunksPending = 0;

      await runIngestProvider({ provider, modelId: model, origin, roleSnapshot: ordinaryRole, usage,
        signal: options.signal, vaultPath, prompt, slug, source, title, body: content, candidates,
        sessionKey: identity?.key,
        summaryPath: summary,
        onCoverage: (pending) => { chunksPending = pending; },
      });
      // Reading the expected page catches a provider that only replied "done".
      await ipc.readFile(`${vaultPath}/${summary}`);
      const changed = (await ipc.fileMtimes(vaultPath))
        .filter(([path, mtime]) => path.startsWith(`${vaultPath}/wiki/`) && before.get(path) !== mtime)
        .map(([path]) => path.slice(vaultPath.length + 1));
      const validation = await ipc.validateIngest(vaultPath, [...new Set([summary, ...changed])]).catch(error => {
        throw new WorkflowOperationError("pending", "unavailable", `Ingest validator unavailable: ${String(error)}`);
      });
      if (validation.errors.length) throw new Error(validation.errors.map((error) => `${error.page}: ${error.detail}`).join("; "));
      if (chunksPending > 0) { sourcesPending++; continue; }
      ingested++;
    } catch (err) {
      const failure = hasDelegatedOutcome ? err : compilationAdmissionError(err);
      errors.push(`${rel}: ${String(failure)}`);
      sourcesPending++;
      const issue = workflowIssue("ingest", failure, rel);
      issues.push(issue);
      if (issue.status === "stopped") { sourcesPending += items.length - index - 1; break; }
    }
  }
  return { ingested, skipped: null, errors, ...(sourcesPending ? { sourcesPending } : {}),
    ...(issues.length || sourcesPending ? { status: partialSession && !issues.some(issue => issue.status === "failed" || issue.status === "stopped")
        ? "partial" : workflowStatus(issues, ingested, sourcesPending) } : {}),
    ...(issues.length ? { issues } : {}),
  };
}
