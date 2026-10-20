// Ingest workflow state + run orchestration. Lives outside PageIngest so an
// in-flight run keeps streaming (and the success banner survives) while the
// user navigates to other pages. PageIngest only holds form drafts.
//
// Streaming: claude_run_stream emits `claude-stream` Tauri events; a listener
// scoped to the active run (subscribed in startIngest, dropped in its finally)
// forwards events into this store. HTTP providers (ollama etc.) have no stream
// — they fall back to the blocking chat path and the UI shows stage + elapsed
// time only.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { Adjacency, AgentVaultSession, CandidatePage, ClaudeStreamPayload, InboxSourceSnapshot, SessionCompileContext, SessionCompileStepResult } from "../lib/ipc";
import type { RoleSnapshot, RoleUsage } from "../lib/modelRoles";
import { complete } from "../lib/chat";
import { buildIngestPlanPrompt, isPlanSourceComplete, parseIngestPlan } from "../lib/ingestPlan";
import type { PlanItem } from "../lib/ingestPlan";
import { runNativeSessionCompile, sessionCompileIO } from "../lib/sessionCompileIO";
import { runExtractiveIngest } from "../lib/extractiveIngest";
import { localTransformNote, selectedLocalTransformModel } from "../lib/localTransform";
import { flattenMarkdown, stem } from "../lib/graphData";
import { tagCandidates } from "../lib/tagIndex";
import { defaultSelection, selectedPlan } from "../lib/planGate";
import { loadProfile } from "../lib/profile";
import { sha256 } from "../lib/tidyRun";
import { log } from "../lib/log";
import { notice } from "../lib/notice";
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { checkSourceText } from "../lib/redaction";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";
import HEADS from "../lib/mycoPromptHeads.json";
import { WorkflowOperationError, workflowIssue, type WorkflowIssue, type WorkflowStatus } from "../lib/workflowOutcome";

// This store logs plain user-facing text (not JSX), so it reads the current
// language directly off uiStore rather than taking a `Strings` prop like
// components do.
function t() {
  return STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
}

/** "writing-raw" is the whole pre-agent stage — judge → ground → plan → the
 *  raw/ write itself, which now happens LAST in it (a refused source must
 *  leave no file behind). The name predates the judgement stage; every
 *  consumer only asks "is a run live", so it stays. "refused" is terminal:
 *  the judge or an all-NOOP plan ended the run with nothing written. */
export type IngestStage =
  | "idle"
  | "writing-raw"
  | "plan-gate"
  | "claude"
  | "indexing"
  | "done"
  | "cancelled"
  | "refused"
  | "error";

/** Why a run ended at "refused". `drop` — junk, nothing written; `log` — the
 *  original was kept in raw/, no model call; `noop` — the plan had nothing
 *  to add (or nothing was approved), nothing written. */
export interface IngestRefusal {
  verdict: "drop" | "log" | "noop";
  reason: string;
  rule: string;
}

/** distill.rs JUNK_MIN_BYTES: the floor `junk_reason` drops a body under. */
const SHORT_NOTE_MAX_BYTES = 200;

/** A short body the junk floor turned away (UX S35): it had content, just
 *  little of it, so the page offers to keep it as a note instead of saying
 *  there was nothing. Measured like the judge, in UTF-8 bytes of the text;
 *  a long body dropped for tool noise is not a short note. */
export function isShortNote(refusal: IngestRefusal, text: string): boolean {
  const body = text.trim();
  return (
    refusal.verdict === "drop" &&
    refusal.rule.startsWith("junk_reason") &&
    body !== "" &&
    new TextEncoder().encode(body).length < SHORT_NOTE_MAX_BYTES
  );
}

/** The line a refusal shows. A `guard::` refusal (the secret/PII check) is
 *  a whole sentence of its own; a judge refusal is framed by its verdict. */
export function refusalLine(refusal: IngestRefusal, s: Strings): string {
  if (refusal.rule.startsWith("guard::")) return refusal.reason;
  return (refusal.verdict === "log" ? s.ing_logged_title : s.ing_refused_title).replace(
    "{reason}",
    refusal.reason,
  );
}

/** One judged source, for the Ingest page's verdict rows and tally. In-memory
 *  for the app session — the durable line is record_noop's, Rust-side. */
export interface JudgedEntry {
  at: number;
  /** The raw/ stem the source would have (or did) become. */
  name: string;
  verdict: IngestRefusal["verdict"] | "harvest";
  reason: string;
  rule: string;
}

/** Verdict rows kept per app session; older ones fall off. */
const JUDGED_CAP = 50;

export interface IngestEvent {
  /** Monotonic id, unique for the process lifetime. React keys the feed rows
   * by this: keying by array index made every append re-render (and re-mount
   * the icon of) all 500 capped rows, because the index of every row shifts
   * once the cap starts dropping the oldest event. */
  seq: number;
  at: number;
  kind: ClaudeStreamPayload["kind"];
  tool?: string;
  detail?: string;
  text?: string;
}

export interface TouchedFile {
  path: string; // vault-relative
  write: boolean; // true once any Write/Edit hit it
}

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

// A retrieval-grounding block: semantic search over the existing vault picks the
// pages this source most likely touches, so the agent UPDATES them (with
// citations) instead of creating near-duplicates — which "identify pages from
// index.md" cannot do once the vault has hundreds of pages. Empty candidates →
// no block, and the prompt is exactly the pre-grounding one.
function candidatesBlock(candidates: CandidatePage[]): string {
  if (candidates.length === 0) return "";
  const lines = candidates
    .map((c) => `   - [[${c.stem}]] (similarity ${c.score.toFixed(2)})`)
    .join("\n");
  return `\n\nSemantic search suggests this source most likely relates to these EXISTING wiki pages. Read the relevant ones FIRST and UPDATE them with citations rather than creating duplicates; only create a new page when none of these fits:\n${lines}`;
}

// A phase-2 plan is richer than a raw candidate list: it already names, per
// topic, whether to ADD/UPDATE/MERGE/NOOP and into which page. Feed it to the
// agent as the plan to follow. Falls back to the phase-1 candidate block when no
// plan was produced (planner unavailable or its reply did not parse).
function groundingBlock(plan: PlanItem[], candidates: CandidatePage[]): string {
  if (plan.length === 0) return candidatesBlock(candidates);
  const lines = plan
    .map((p) => {
      const tgt = p.target ? ` [[${p.target}]]` : "";
      const why = p.reason ? ` — ${p.reason}` : "";
      return `   - ${p.decision}${tgt}: ${p.subject}${why}`;
    })
    .join("\n");
  return `\n\nA preliminary analysis produced this ingest plan. Follow it, adjusting only where the source clearly warrants — UPDATE/MERGE into the named existing pages with citations rather than creating duplicates:\n${lines}`;
}

// A profile grounding line (Phase B, Task 6): weights linking/tagging toward
// the user's stated interests without dictating specific decisions — the
// plan/candidate blocks above already do that. Empty `interests` (no
// profile, or a profile with no interests) keeps this exactly "" so every
// existing caller/snapshot that doesn't pass it is untouched.
function interestsLine(interests: string): string {
  return interests
    ? `\n\nUser interests (weight linking/tagging toward these): ${interests}`
    : "";
}

// Exported for fullTierIngest.ts (Phase B, Task 3) — the headless full-tier
// ingest pass builds the identical prompt for its own candidates, rather than
// a second hand-maintained copy. `slug` is the source's path under raw/
// without `.md`: a bare stem, or `archive/<month>/<stem>` when ingest reuses
// an archived copy. The summary page and report take the file's own stem,
// which is what `[^src-<stem>]` citations resolve by.
export const INGEST_PROMPT = (
  slug: string,
  title: string,
  candidates: CandidatePage[] = [],
  plan: PlanItem[] = [],
  profileInterests = "",
  summarySlug = slug.split("/").pop(),
  summaryPath = `wiki/source-${summarySlug}.md`,
  sessionKey?: string,
) =>
  `${HEADS.ingest}${slug}.md\` (title: "${title}"). Please ingest it into the wiki following the workflow in CLAUDE.md:

1. Read the source completely.
2. Identify pages it affects (entities, concepts, techniques, analyses).
3. Update existing pages with inline citations, or create new pages with required frontmatter.
4. Create or update the source-summary page \`${summaryPath}\`. Keep its path stable across session updates. Preserve human annotations and existing source citations, refresh the readable title and work themes, and distinguish requests, reported results, and remaining work. Cite the current immutable raw source for new claims.${sessionKey ? ` Store \`session_key: ${JSON.stringify(sessionKey)}\` in its frontmatter so subsequent revisions find this same page.` : ""}
5. Update \`wiki/index.md\` and append a \`wiki/log.md\` entry.
6. Write an ingest report at \`ingest-reports/<datetime>-${summarySlug}.md\` summarising what was created/modified and why.${groundingBlock(plan, candidates)}${interestsLine(profileInterests)}

When done, output a one-line confirmation.`;

/** Args for the two non-streaming provider branches (see `runIngestProvider`'s
 * own doc comment for why the third — anthropic-cli — is not here too). */
export interface IngestProviderArgs {
  provider: string;
  vaultPath: string;
  prompt: string;
  slug: string;
  /** The source's path under raw/ without `.md`, when it is not `slug`
   *  itself (a reused `archive/<month>/<slug>`). */
  source?: string;
  sessionKey?: string;
  summaryPath?: string;
  title: string;
  body: string;
  /** Retrieval grounding (`wikify_candidates`). The model branches already
   *  carry it inside `prompt`; the offline branch needs it as data, to link
   *  the same pages under `## Related`. */
  candidates?: CandidatePage[];
  onCoverage?: (chunksPending: number) => void;
  /** Confirmed writes from the local pipeline, independent of mtime precision. */
  onWritten?: (paths: string[]) => void;
  signal?: AbortSignal;
  /** Interactive runs retain the role model captured with their run settings. */
  modelId?: string;
  origin?: AgentVaultSession;
  roleSnapshot?: RoleSnapshot;
  usage?: RoleUsage;
  sessionCompile?: SessionCompileContext;
}

/** Runs one already-built ingest `prompt` through myco Pro or a plain
 * (non-streaming) provider call — a mechanical extraction of two of
 * `startIngest`'s three original provider branches (myco-pro, and the
 * catch-all `complete({task:"ingest"})`), same behavior, now shared with
 * `fullTierIngest.ts` (Phase B, Task 3).
 *
 * The THIRD original branch — `anthropic-cli`, via `claudeRunStream` bound to
 * a `runId` and the `claude-stream` event listener that feeds this store's
 * `events`/`touched`/live-graph state — is deliberately NOT covered: it
 * cannot be pulled out without either dragging that UI wiring along or
 * changing what the interactive Ingest page shows mid-run, so `startIngest`
 * keeps it inline. `fullTierIngest.ts` has no UI to stream into either; it
 * calls `ipc.claudeRun` (the blocking variant) directly for that provider
 * instead of going through here — see that module's own doc comment. */
export async function runIngestProvider(args: IngestProviderArgs): Promise<string> {
  const usage = args.usage ?? args.sessionCompile?.roleSnapshot.usage ?? args.roleSnapshot?.usage ?? "foreground";
  const suppliedRole = args.sessionCompile?.roleSnapshot ?? args.roleSnapshot;
  if (usage === "automatic" && !suppliedRole) {
    throw new WorkflowOperationError("pending", "unavailable", "Automatic compilation requires its originating native role grant");
  }
  const origin = args.sessionCompile?.origin ?? args.origin ?? suppliedRole?.origin ?? await ipc.agentVaultSession();
  const roleSnapshot = suppliedRole ?? await ipc.captureModelRole(origin, "compilation", usage);
  const { providerId: provider, modelId } = roleSnapshot.routeSignature;
  if (origin.vaultPath !== args.vaultPath || roleSnapshot.origin.vaultPath !== origin.vaultPath ||
      roleSnapshot.origin.openingToken !== origin.openingToken || roleSnapshot.role !== "compilation" ||
      roleSnapshot.usage !== usage || provider !== args.provider || (args.modelId !== undefined && args.modelId !== modelId)) {
    throw new WorkflowOperationError("pending", "unavailable", "Compilation route differs from its originating native role grant");
  }
  if (args.signal?.aborted) throw new Error("cancelled");
  if (provider === "builtin-local") {
    const localModelId = selectedLocalTransformModel(provider, modelId);
    const { written, chunksPending, localPreview } = await runExtractiveIngest(args.sessionCompile ? sessionCompileIO(args.sessionCompile) : ipc, t(), {
      vaultPath: args.vaultPath,
      slug: args.slug,
      source: args.source,
      sessionKey: args.sessionKey,
      sessionCompile: args.sessionCompile,
      origin,
      roleSnapshot,
      summaryPath: args.summaryPath,
      title: args.title,
      body: args.body,
      candidates: args.candidates ?? [],
      pageStems: new Set(flattenMarkdown(useVaultStore.getState().fileTree).map(stem)),
      // The vault's own tag vocabulary — the offline path reuses tags, never
      // coins them (see matchedTags).
      vaultTags: tagCandidates(useVaultStore.getState().adjacency?.tags ?? {}),
      localModelId,
      lang: useUIStore.getState().lang,
      signal: args.signal,
    });
    args.onCoverage?.(chunksPending);
    args.onWritten?.(written);
    return (localPreview ? localTransformNote(localPreview, t()) : t().ing_extractive_hint) +
      (chunksPending ? `\n${t().ing_extractive_pending.replace("{n}", String(chunksPending))}` : "") +
      `\n\n${written.map((f) => `- ${f}`).join("\n")}`;
  }
  if (provider === "myco-pro") {
    // Native requires this original grant and refuses execution until a
    // staged checked publication adapter is available.
    const result = await ipc.mycoProIngest(args.slug, args.title, args.body, origin, roleSnapshot);
    return `${result.summary}\n\n(${result.applied} wiki file${
      result.applied === 1 ? "" : "s"
    } updated via myco Pro)`;
  }
  // Other providers (gemini/codex CLIs, HTTP APIs, ollama) have no tool-event
  // stream; blocking call.
  return complete({
    task: "ingest",
    featureRole: "compilation", origin, roleSnapshot, usage,
    cwd: args.vaultPath,
    messages: [{ role: "user", content: args.prompt }],
  });
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "source"
  );
}

export interface InboxCompilationResult {
  context: SessionCompileContext;
  result: SessionCompileStepResult;
}

interface IngestState {
  stage: IngestStage;
  workflowStatus: WorkflowStatus | null;
  workflowIssues: WorkflowIssue[];
  log: string;
  events: IngestEvent[];
  touched: TouchedFile[];
  /** Vault-relative wiki pages the run changed, from the mtime diff that
   * verified it; set at "done". The success card links these, not `touched`:
   * that list is the model's streamed tool input (claude.rs cuts it at 160
   * chars) and stays empty for providers that stream no events. */
  changedPages: string[];
  /** Unquoted source chunks still waiting for the next bounded local pass. */
  sourceChunksPending: number;
  readCount: number;
  writeCount: number;
  model: string | null;
  runId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** When the plan gate opened; null once it closes with a choice. While
   *  set, the run's clock stands at this moment (runElapsedMs). */
  gateAt: number | null;
  /** The text this run was given, shown folded under the plan gate (the
   *  form that held it is hidden while the run is up). */
  sourceText: string;
  reportPath: string | null;
  vaultPath: string | null;
  /** Existing pages the source was matched to (retrieval grounding); injected
   * into the ingest prompt so the agent updates them instead of duplicating.
   * Empty when the vector index is absent/stale — grounding is best-effort. */
  candidates: CandidatePage[];
  /** Structured ingest plan (ADD/UPDATE/MERGE/NOOP per topic) from a read-only
   * planning call before the writing agent runs; injected into the prompt and
   * shown as telemetry. Empty when the planner is unavailable or its reply did
   * not parse — ingest then falls back to phase-1 candidate grounding. */
  plan: PlanItem[];
  /** Set when the run ended at stage "refused"; null otherwise. */
  refusal: IngestRefusal | null;
  /** Where a "cancelled" run stopped: at the plan gate (the run never
   * reached steps 3-5) or mid-run (it passed the gate). Null otherwise. */
  cancelledAt: "gate" | "run" | null;
  /** The plan gate was shown to the user this run. A headless run has a
   * plan and no gate, so the plan alone cannot say a choice was made. */
  gated: boolean;
  /** Newest first. Survives reset(): it is the session's judgement log,
   *  not one run's state. */
  judged: JudgedEntry[];
  /** Fresh link graph rescanned (debounced) after each streamed write, so
   * live views (mini graph, galaxy growth) see edges of pages created
   * mid-run. Never written to vaultStore.adjacency — that would tear down
   * the graph page renderer. */
  liveAdjacency: Adjacency | null;
  /** false after a run finishes until the user visits the Ingest page —
   * drives the "done/failed" Topbar chip. */
  seen: boolean;
  /** Bumped AFTER an inbox source's archive move lands on disk — the pending
   * _inbox list refetches on this, not on `stage` alone: the stage flips to
   * "done" before the archive IPC completes, and a stage-keyed refetch races
   * it into showing an already-consumed (soon-dead-path) row. */
  inboxRev: number;
  bumpInboxRev: () => void;
  /** `headless: true` skips the plan gate for unattended paste/import callers.
   * `sourceMarker` (mediaIngest's retryStableSourceText) goes into the raw
   * copy above the body, so a retry of the same image finds that copy. */
  startIngest: (
    title: string,
    body: string,
    opts?: { headless?: boolean; sourceMarker?: string; expectedVaultPath?: string; usage?: RoleUsage },
  ) => Promise<void>;
  startInboxCompilation: (snapshot: InboxSourceSnapshot,
    options: { usage: RoleUsage; expectedVaultToken: string }) => Promise<InboxCompilationResult>;
  /** Resolves a pending plan gate with the reviewed checkbox state. */
  resolvePlanGate: (sel: boolean[]) => void;
  /** Resolves a pending plan gate with the default selection (all non-NOOP). */
  skipPlanGate: () => void;
  cancelIngest: () => void;
  markSeen: () => void;
  reset: () => void;
}

function relativize(path: string, vaultPath: string | null): string {
  if (vaultPath && path.startsWith(vaultPath)) {
    return path.slice(vaultPath.length).replace(/^\//, "");
  }
  return path;
}

let activeLocalIngest: { runId: string; controller: AbortController } | null = null;

export const useIngestStore = create<IngestState>((set, get) => ({
  stage: "idle",
  workflowStatus: null,
  workflowIssues: [],
  log: "",
  events: [],
  touched: [],
  changedPages: [],
  sourceChunksPending: 0,
  readCount: 0,
  writeCount: 0,
  model: null,
  runId: null,
  startedAt: null,
  finishedAt: null,
  gateAt: null,
  sourceText: "",
  reportPath: null,
  vaultPath: null,
  candidates: [],
  plan: [],
  refusal: null,
  cancelledAt: null,
  gated: false,
  judged: [],
  liveAdjacency: null,
  seen: true,
  inboxRev: 0,

  async startInboxCompilation(snapshot, options) {
    const current = useVaultStore.getState();
    if (
      current.isOpeningVault ||
      current.currentVault?.path !== snapshot.origin.vaultPath ||
      !options.expectedVaultToken ||
      current.vaultToken !== options.expectedVaultToken ||
      !snapshot.origin.openingToken
    ) {
      throw new WorkflowOperationError(
        "stopped",
        "cancelled",
        "The originating vault opening is no longer active",
      );
    }
    if (
      ["writing-raw", "plan-gate", "claude", "indexing"].includes(get().stage)
    ) {
      throw new WorkflowOperationError(
        "pending",
        "unavailable",
        "Another ingest is already active",
      );
    }
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    const isCurrent = (): boolean => {
      const active = useVaultStore.getState();
      return (
        get().runId === runId &&
        !controller.signal.aborted &&
        !active.isOpeningVault &&
        active.currentVault?.path === snapshot.origin.vaultPath &&
        active.vaultToken === options.expectedVaultToken
      );
    };
    const ensureCurrent = (): void => {
      if (!isCurrent())
        throw new WorkflowOperationError(
          "stopped",
          "cancelled",
          "The originating vault opening is no longer active",
        );
    };
    set({
      stage: "writing-raw",
      workflowStatus: null,
      workflowIssues: [],
      runId,
      startedAt: Date.now(),
      finishedAt: null,
      vaultPath: snapshot.origin.vaultPath,
      sourceText: snapshot.text,
      sourceChunksPending: 0,
      log: "",
      events: [],
      touched: [],
      changedPages: [],
      reportPath: null,
      model: null,
      candidates: [],
      plan: [],
      refusal: null,
      gated: false,
      gateAt: null,
      cancelledAt: null,
      readCount: 0,
      writeCount: 0,
      liveAdjacency: null,
      seen: true,
    });
    activeLocalIngest = { runId, controller };
    const unsubscribe =
      typeof useVaultStore.subscribe === "function"
        ? useVaultStore.subscribe(() => {
            if (!isCurrent()) controller.abort();
          })
        : undefined;
    try {
      const context = await ipc
        .inboxCompileBegin(snapshot, options.usage)
        .catch((error) => {
          ensureCurrent();
          throw new WorkflowOperationError(
            "pending",
            "unavailable",
            `Source admission unavailable: ${String(error)}`,
          );
        });
      ensureCurrent();
      if (
        context.origin.vaultPath !== snapshot.origin.vaultPath ||
        context.origin.openingToken !== snapshot.origin.openingToken ||
        context.source.sourceRevision !== snapshot.sourceRevision ||
        context.roleSnapshot.role !== "compilation" ||
        context.roleSnapshot.usage !== options.usage ||
        context.roleSnapshot.origin.vaultPath !== snapshot.origin.vaultPath ||
        context.roleSnapshot.origin.openingToken !==
          snapshot.origin.openingToken
      ) {
        throw new Error(
          "Inbox compiler differs from its originating source/opening/role",
        );
      }
      set({
        stage: "claude",
        model: context.roleSnapshot.routeSignature.modelId,
      });
      const result = await runNativeSessionCompile(context, {
        lang: useUIStore.getState().lang,
        signal: controller.signal,
        onProgress: (progress) => {
          if (isCurrent())
            set({
              sourceChunksPending:
                progress.eligibleWindows - progress.nextPacket,
            });
        },
      });
      ensureCurrent();
      const completed = result.state === "completed";
      set({
        stage: "done",
        workflowStatus: completed ? "success" : "partial",
        finishedAt: Date.now(),
        sourceChunksPending: result.eligibleWindows - result.nextPacket,
        seen: false,
        changedPages: completed ? [context.summaryPath] : [],
        reportPath: null,
        log:
          t()
            .session_compile_progress.replace(
              "{processed}",
              String(result.nextPacket),
            )
            .replace("{total}", String(result.eligibleWindows)) +
          (completed ? "" : ` · ${t().workflow_partial}`),
      });
      return { context, result };
    } catch (error) {
      if (get().runId === runId) {
        const issue = workflowIssue("ingest", error);
        set({
          stage: issue.status === "stopped" ? "cancelled" : "error",
          workflowStatus: issue.status,
          workflowIssues: [issue],
          finishedAt: Date.now(),
          seen: false,
          changedPages: [],
          reportPath: null,
          log: String(error),
        });
      }
      throw error;
    } finally {
      unsubscribe?.();
      if (activeLocalIngest?.runId === runId) activeLocalIngest = null;
    }
  },

  async startIngest(
    title: string,
    body: string,
    opts?: {
      headless?: boolean;
      sourceMarker?: string;
      expectedVaultPath?: string;
      usage?: RoleUsage;
    },
  ) {
    const origin = useVaultStore.getState();
    const vault = origin.currentVault;
    if (opts?.expectedVaultPath && vault?.path !== opts.expectedVaultPath) {
      throw new Error("The active vault changed before ingest started");
    }
    if (!vault) return;
    const s = get();
    if (
      s.stage === "writing-raw" ||
      s.stage === "plan-gate" ||
      s.stage === "claude" ||
      s.stage === "indexing"
    )
      return; // one run at a time

    // An empty title is named after the body once the run is claimed (below).
    let finalTitle = title.trim() || "untitled";
    // Provisional slug for the log line before the run is claimed. The effective
    // one is resolved below against the filesystem, since raw/ is immutable and a
    // same-titled re-ingest must land on its own path, not overwrite the first.
    let slug = slugify(finalTitle);
    // Where the original sits, vault-relative. Only writeRaw changes it.
    let rawRel = `raw/${slug}.md`;
    // `rawRel` minus `raw/` and `.md` — what INGEST_PROMPT and the no-changes
    // warning put back between those two.
    const rawStem = (): string =>
      rawRel.replace(/^raw\//, "").replace(/\.md$/i, "");
    const runId = crypto.randomUUID();
    let localController: AbortController | undefined;
    let unsubscribeLocalVault: (() => void) | undefined;
    const canPublishResult = (): boolean => {
      if (get().runId !== runId || get().stage === "cancelled") return false;
      const current = useVaultStore.getState();
      if (
        localController?.signal.aborted ||
        current.isOpeningVault ||
        current.currentVault?.path !== vault.path ||
        current.vaultToken !== origin.vaultToken
      ) {
        throw new Error("cancelled");
      }
      return true;
    };

    // Claim the run before awaiting anything. `listen()` is async, so the guard
    // above and this set() would otherwise straddle a microtask boundary and
    // two callers in the same tick would both start an agent — runInboxPass has
    // two triggers (clip-saved, interval) that arrive through identical IPCs.
    set({
      stage: "writing-raw",
      workflowStatus: null,
      workflowIssues: [],
      log: `Judging ${slug}…`,
      events: [],
      touched: [],
      changedPages: [],
      sourceChunksPending: 0,
      readCount: 0,
      writeCount: 0,
      model: null,
      runId,
      startedAt: Date.now(),
      finishedAt: null,
      gateAt: null,
      sourceText: body,
      reportPath: null,
      vaultPath: vault.path,
      candidates: [],
      plan: [],
      refusal: null,
      cancelledAt: null,
      gated: false,
      liveAdjacency: null,
      seen: true,
    });
    const text = body.trim();

    // The immutable original. Called as LATE as possible — after the judge
    // and the plan gate — so a refused source leaves no file behind at all.
    // Resolves a free raw/ path first: a second source under the same title
    // gets its own original instead of overwriting the first (which the
    // command layer refuses outright). Lookup failures retain the pending input.
    //
    // One copy per body (spec 2026-10-02-raw-hygiene): a source already in
    // raw/ — top level or raw/archive/ — is reused, not written again. A
    // retried source used to add raw/<slug>-2.md, -3.md, … on every pass, and
    // raw/ being immutable, none could be removed. Resolves true when the reused copy's name
    // is one another raw copy also has (see the check after the call).
    const writeRaw = async (): Promise<boolean> => {
      const marker = opts?.sourceMarker ? `${opts.sourceMarker}\n\n` : "";
      const shown = text.length > 0 ? text : "_(empty)_";
      const payload = `# ${finalTitle}\n\n${marker}${shown}\n`;
      const existing = await ipc.findRawCopy(payload).catch((err) => {
        throw new WorkflowOperationError(
          "pending",
          "unavailable",
          `Raw copy lookup unavailable: ${String(err)}`,
        );
      });
      if (existing) {
        rawRel = existing.path;
        slug = rawStem().split("/").pop()!;
        set({ log: t().ing_raw_reused.replace("{path}", rawRel) });
        return existing.shared;
      }
      try {
        await ipc.createFolder(vault.path, "raw");
      } catch (error) {
        if (!/already exists|\(os error 17\)/i.test(String(error))) throw error;
      }
      rawRel = await ipc.availableRawPath(slug).catch((error) => {
        throw new WorkflowOperationError(
          "pending",
          "unavailable",
          `Raw path lookup unavailable: ${String(error)}`,
        );
      });
      slug = rawRel.replace(/^raw\//, "").replace(/\.md$/, "");
      set({ log: `Writing ${rawRel}…` });
      await ipc.writeFile(`${vault.path}/${rawRel}`, payload);
      await useVaultStore.getState().refreshTree();
      return false;
    };

    // End the run with nothing (or, for `log`, only raw/) written: one
    // judgement-log line, one toast, a terminal stage the Ingest page can
    // read. `seen` stays true — the toast IS the feedback; a chip pop on top
    // would be the same event twice (noticeStore's one rule).
    const refuse = async (refusal: IngestRefusal): Promise<void> => {
      // A guard refusal leaves no trace on disk: the noop log line carries
      // the slug, and a typed title can hold the very key that was refused.
      if (!refusal.rule.startsWith("guard::")) {
        await ipc
          .recordNoop(rawRel, `${refusal.verdict}: ${refusal.reason}`)
          .catch((err) => {
            log.warn("record_noop.failed", {
              feature: "ingest",
              error: String(err),
            });
          });
      }
      notice.info(
        isShortNote(refusal, text)
          ? t().ing_short_title
          : refusalLine(refusal, t()),
        { icon: "stop" },
      );
      set((st) => ({
        stage: "refused",
        workflowStatus: "skipped",
        refusal,
        finishedAt: Date.now(),
        seen: true,
        // A guard refusal drops the earlier lines: they name the typed title.
        log: `${refusal.rule.startsWith("guard::") ? "" : `${st.log}\n\n`}${refusal.rule}: ${refusal.reason}`,
        judged: [
          { at: Date.now(), name: slug, ...refusal },
          ...st.judged.slice(0, JUDGED_CAP - 1),
        ],
      }));
    };

    try {
      await startStreamListener();
      if (!canPublishResult()) return;
      if (!title.trim()) {
        // By the body, not the clock: the name goes into the raw payload, so
        // `untitled-<time>` made every attempt at one pasted text a new body
        // and a new permanent raw copy. Another body hashes to another name.
        finalTitle = `untitled-${(await sha256(text)).slice(0, 8)}`;
        slug = slugify(finalTitle);
        rawRel = `raw/${slug}.md`;
      }

      // The secret/PII check (spec 2026-10-03-paste-guard) — pasted text and
      // YouTube transcripts reach raw/ only through here, and raw/ is
      // immutable. Before the judge and the planner, so a refused text never
      // reaches a model either. The title is scanned too: it becomes the raw/
      // file's heading. An unreadable setting cannot lower the paste guard.
      const guardSettings = await ipc.getSettings().catch((error) => {
        throw new WorkflowOperationError(
          "pending",
          "unavailable",
          `Paste guard settings unavailable: ${String(error)}`,
        );
      });
      const check = await checkSourceText(
        `${finalTitle}\n\n${text}`,
        ipc.scanTextSecrets,
        guardSettings?.pii_quarantine_enabled ?? false,
      );
      if (!check.ok) {
        const reasons = {
          secret: t().ing_guard_secret,
          pii: t().ing_guard_pii,
          scan: t().ing_guard_scan,
        };
        // The verdict row prints the name, and a typed title can hold the
        // flagged text — name the refusal by the body's hash instead.
        slug = `untitled-${(await sha256(text)).slice(0, 8)}`;
        await refuse({
          verdict: "drop",
          reason: reasons[check.code],
          rule: `guard::${check.code}`,
        });
        return;
      }
      if (check.piiWarn && !opts?.headless) notice.warn(t().ing_guard_pii_warn);

      // Judgement stage — before anything touches disk or a model. A source
      // that is junk (`drop`) or only worth keeping (`log`) never reaches
      // the planner. An unavailable admission check leaves the source pending.
      const verdict = await ipc
        .judgeSource(text, new TextEncoder().encode(text).length)
        .catch((err) => {
          throw new WorkflowOperationError(
            "pending",
            "unavailable",
            `Source admission unavailable: ${String(err)}`,
          );
        });
      if (verdict && verdict.verdict !== "harvest") {
        if (verdict.verdict === "log") await writeRaw();
        await refuse({
          verdict: verdict.verdict,
          reason: verdict.reason,
          rule: verdict.rule,
        });
        return;
      }

      // Snapshot wiki/ mtimes before the model runs so we can verify it
      // actually wrote something, rather than reporting success for a no-op.
      const wikiBefore = new Map(
        (await ipc.fileMtimes(vault.path))
          .filter(([p]) => p.includes("/wiki/"))
          .map(([p, m]) => [p, m] as const),
      );

      // Retrieval grounding: find existing pages this source likely relates to
      // so the prompt tells the agent to update them, not duplicate. Best-effort
      // — an absent/stale vector index yields none and ingest proceeds unchanged.
      const candidates = await ipc.wikifyCandidates(text, 8).catch((error) => {
        log.warn("ingest.candidates_unavailable", { error: String(error) });
        return [] as CandidatePage[];
      });
      set({ candidates });

      // Read once, up here: the planner below is skipped entirely for the
      // offline provider, and that decision needs the ingest role before the
      // first model call, not after it.
      const nativeOrigin = Object.freeze(await ipc.agentVaultSession());
      if (!canPublishResult()) return;
      if (nativeOrigin.vaultPath !== vault.path)
        throw new Error("The active vault changed before compilation started");
      const usage =
        opts?.usage ?? (opts?.headless ? "automatic" : "foreground");
      const roleSnapshot = await ipc
        .captureModelRole(nativeOrigin, "compilation", usage)
        .catch((error) => {
          throw new WorkflowOperationError(
            "pending",
            "unavailable",
            `Compilation role unavailable: ${String(error)}`,
          );
        });
      if (!canPublishResult()) return;
      const {
        providerId: provider,
        modelId,
        effort,
      } = roleSnapshot.routeSignature;
      // "Makes no model call" is what the offline run's report prints, so it
      // has to be true of the WHOLE run — including the planner, which takes
      // the generate role and so would happily reach for some other connected
      // provider. No plan means no plan gate either; grounding falls back to
      // the candidate list, exactly as it does when a planner is unavailable.
      const offline = provider === "builtin-local";

      // Phase 2: one read-only planning call turns the source + candidates into
      // explicit ADD/UPDATE/MERGE/NOOP decisions, shown as telemetry and fed to
      // the writing agent. Best-effort — a failure or unparseable reply leaves
      // the plan empty and the prompt falls back to candidate grounding.
      let plan: PlanItem[] = [];
      if (!offline) {
        const plannerRole = await ipc
          .captureModelRole(nativeOrigin, "organization", usage)
          .catch((error) => {
            throw new WorkflowOperationError(
              "pending",
              "unavailable",
              `Planning role unavailable: ${String(error)}`,
            );
          });
        if (!canPublishResult()) return;
        try {
          set({ log: `Planning ${slug}…` });
          const planReply = await complete({
            task: "generate",
            featureRole: "organization",
            origin: nativeOrigin,
            roleSnapshot: plannerRole,
            usage,
            cwd: vault.path,
            messages: [
              {
                role: "user",
                content: buildIngestPlanPrompt(text, candidates),
              },
            ],
          });
          plan = parseIngestPlan(planReply);
          if (!isPlanSourceComplete(text))
            plan = plan.filter((item) => item.decision !== "NOOP");
        } catch (error) {
          log.warn("ingest.plan_failed", { error: String(error) });
        }
      }
      set({ plan });

      // The planner already said there is nothing to add. Running the writing
      // agent anyway is how the vault got its "no actionable content" pages,
      // index/log lines and empty ingest reports: end here, write nothing.
      if (plan.length > 0 && plan.every((p) => p.decision === "NOOP")) {
        await refuse({
          verdict: "noop",
          reason: t().ing_noop_reason,
          rule: "ingestPlan::all_noop",
        });
        return;
      }

      // Plan gate (Q4 item 7): pause a manual run for a per-item checkbox
      // review before the writing agent touches the wiki. Headless callers
      // (autoIngest's inbox pass) skip it — nobody is watching, and an
      // unresolved gate would park the run (and block future passes) forever.
      // fullTierIngest.ts never reaches here at all: it builds INGEST_PROMPT
      // directly and does not call startIngest.
      if (plan.length > 0 && !opts?.headless) {
        set({ stage: "plan-gate", gated: true, gateAt: Date.now() });
        const sel = await new Promise<boolean[] | null>((res) => {
          planGateResolver = res;
        });
        planGateResolver = null;
        if (sel === null) {
          // Cancelled at the gate — nothing has run and nothing was written.
          // A terminal stage, not idle: idle dropped the rail and brought the
          // form back with no word of what happened. The finally block drops
          // the stream listener.
          set({
            stage: "cancelled",
            workflowStatus: "stopped",
            cancelledAt: "gate",
            finishedAt: Date.now(),
          });
          return;
        }
        plan = selectedPlan(plan, sel);
        // The time spent choosing is the user's, not the run's: move the
        // start forward by it, so the clock resumes where the gate held it.
        // Back to the live pre-agent stage: the choice is made, and a stage
        // left at "plan-gate" read "waiting for your choice · 0:00".
        set((st) => ({
          plan,
          stage: "writing-raw",
          gateAt: null,
          startedAt:
            st.startedAt !== null && st.gateAt !== null
              ? st.startedAt + (Date.now() - st.gateAt)
              : st.startedAt,
        }));
        if (plan.length === 0) {
          // "Apply 0" — the same nothing-to-do as an all-NOOP plan.
          await refuse({
            verdict: "noop",
            reason: t().ing_gate_none_reason,
            rule: "planGate::none_selected",
          });
          return;
        }
      }

      // Only now does anything touch disk.
      if (await writeRaw()) {
        // The reused copy's stem is another raw copy's too (a vault from
        // before raw names counted raw/archive/). The summary page and the
        // citations go by stem, so ingesting would write over the other
        // body's summary. Keep the original only; writing a second copy
        // under a free name would break "one raw copy per body".
        await refuse({
          verdict: "log",
          reason: t().ing_raw_name_shared.replace("{path}", rawRel),
          rule: "raw::name_shared",
        });
        return;
      }

      if (selectedLocalTransformModel(provider, modelId)) {
        localController = new AbortController();
        activeLocalIngest = { runId, controller: localController };
        const abortIfVaultChanged = (
          state: ReturnType<typeof useVaultStore.getState>,
        ): void => {
          if (
            state.isOpeningVault ||
            state.currentVault?.path !== vault.path ||
            state.vaultToken !== origin.vaultToken
          ) {
            localController?.abort();
          }
        };
        if (typeof useVaultStore.subscribe === "function")
          unsubscribeLocalVault = useVaultStore.subscribe(abortIfVaultChanged);
        abortIfVaultChanged(useVaultStore.getState());
      }
      set({ stage: "claude" });
      // Phase B, Task 6: weight linking/tagging toward the user's stated
      // interests — a lighter grounding line than chat.ts's full profile
      // paragraph, but sent to the same configured provider, so it is
      // governed by the same `profile_injection` toggle (review-caught: the
      // brief's "when a profile exists" wording missed the master spec's
      // privacy principle that the toggle covers every path that sends
      // profile content to a provider). Fail CLOSED on a config-read error —
      // omit the line rather than risk leaking interests past a toggle we
      // couldn't confirm is on.
      const distillCfg = await ipc
        .getDistillConfig(vault.path)
        .catch(() => null);
      const profile = distillCfg?.profile_injection
        ? await loadProfile(vault.path)
        : null;
      const prompt = INGEST_PROMPT(
        rawStem(),
        finalTitle,
        candidates,
        plan,
        profile?.interests.join(", ") ?? "",
      );
      let out: string;
      let confirmedWrites: string[] = [];
      if (provider === "anthropic-cli") {
        // Pass the chosen model (e.g. "haiku") so ingest can run on a cheaper
        // model; empty -> the CLI's configured default.
        const res = await ipc.claudeRunStream(
          runId,
          prompt,
          vault.path,
          modelId || undefined,
          effort,
          { capability: "staged-write", origin: nativeOrigin, roleSnapshot },
        );
        if (res.status !== 0) {
          throw new Error(res.stderr.trim() || `claude exit ${res.status}`);
        }
        out = res.stdout.trim();
        // Opt-in persistence: the streamed run accumulated a transcript in
        // `events` — write it to runs/ alongside the final output.
        await persistRunTranscript(vault.path, runId, out);
      } else {
        // myco Pro / other providers — no tool-event stream, stage UI only.
        // See runIngestProvider's own doc comment for why anthropic-cli
        // (above) is the one branch it does not cover.
        out = await runIngestProvider({
          provider,
          vaultPath: vault.path,
          prompt,
          slug,
          source: rawStem(),
          title: finalTitle,
          body: body.trim(),
          candidates,
          signal: localController?.signal,
          modelId,
          origin: nativeOrigin,
          roleSnapshot,
          usage,
          onCoverage: (sourceChunksPending) => set({ sourceChunksPending }),
          onWritten: (paths) => {
            confirmedWrites = paths;
          },
        });
      }
      if (!canPublishResult()) return;
      set((st) => ({ log: `${st.log}\n\n${out}` }));

      set({ stage: "indexing" });
      await useVaultStore.getState().refreshTree();
      if (!canPublishResult()) return;
      await useVaultStore.getState().refreshLinkGraph();
      if (!canPublishResult()) return;

      // Verify the wiki changed: a new wiki page appeared or an existing one
      // was modified. If nothing changed, the model replied but did not ingest.
      const afterMtimes = await ipc.fileMtimes(vault.path);
      if (!canPublishResult()) return;
      // ipc.fileMtimes returns absolute filesystem paths, but validateIngest
      // (Rust validate_pages) requires vault-relative paths — its loop does
      // `if !rel.starts_with("wiki/")` and silently skips anything else, so an
      // un-relativized path here makes the validator a silent no-op.
      const changed = [
        ...new Set([
          ...afterMtimes
            .filter(
              ([p, m]) =>
                p.includes("/wiki/") &&
                (!wikiBefore.has(p) || m > (wikiBefore.get(p) ?? 0)),
            )
            .map(([p]) => relativize(p, vault.path)),
          ...confirmedWrites.filter((path) => path.startsWith("wiki/")),
        ]),
      ];
      if (changed.length === 0) {
        set((st) => ({
          finishedAt: Date.now(),
          stage: "error",
          workflowStatus: "failed",
          workflowIssues: [
            workflowIssue(
              "ingest",
              new Error("Provider finished without verified wiki changes"),
            ),
          ],
          seen: false,
          log: `${st.log}\n\n${(
            t().ingest_no_changes ??
            "WARNING: the model finished but no wiki pages were created or " +
              "updated. The source was saved to raw/{slug}.md, but nothing " +
              "was ingested into the wiki. Check the model output above, or " +
              "try the Claude Code (CLI) provider."
          ).replace("{slug}", rawStem())}`,
        }));
        return;
      }

      // Deterministic validator (Phase 1f): dangling citations / missing
      // required frontmatter / invalid enums fail the ingest outright;
      // unresolved wikilinks / source_count mismatch / missing superseded_by
      // are reported but do not block. A unavailable validator cannot certify
      // the writes: preserve the source for a retry rather than publishing done.
      const vr = await ipc
        .validateIngest(vault.path, changed)
        .catch((error) => {
          throw new WorkflowOperationError(
            "pending",
            "unavailable",
            `Ingest validator unavailable: ${String(error)}`,
          );
        });
      if (!canPublishResult()) return;
      if (vr && vr.errors.length > 0) {
        const lines = vr.errors
          .map((e) => `- ${e.page}: ${e.detail}`)
          .join("\n");
        set((st) => ({
          finishedAt: Date.now(),
          stage: "error",
          workflowStatus: "failed",
          workflowIssues: [workflowIssue("validation", new Error(lines))],
          seen: false,
          log: `${st.log}\n\n${
            t().ingest_validation_failed ?? "Ingest validation failed:"
          }\n${lines}`,
        }));
        return;
      }
      const warnLines =
        vr && vr.warnings.length > 0
          ? `\n\n${
              t().ingest_validation_warnings ?? "Validation warnings:"
            }\n${vr.warnings.map((w) => `- ${w.page}: ${w.detail}`).join("\n")}`
          : "";

      // Open the report the model actually wrote (newest matching file),
      // instead of guessing the filename from today's date.
      const report = afterMtimes
        .filter(
          ([p]) => p.includes("/ingest-reports/") && p.endsWith(`-${slug}.md`),
        )
        .sort((a, b) => b[1] - a[1])[0];
      set((st) => ({
        reportPath: report ? report[0] : null,
        changedPages: changed,
        finishedAt: Date.now(),
        stage: "done",
        workflowStatus: st.sourceChunksPending > 0 ? "partial" : "success",
        seen: false,
        log: `${st.log}${warnLines}`,
        judged: [
          {
            at: Date.now(),
            name: slug,
            verdict: "harvest",
            reason: `${changed.length} wiki page(s) changed`,
            rule: "judge::pass",
          },
          ...st.judged.slice(0, JUDGED_CAP - 1),
        ],
      }));
    } catch (err) {
      if (get().runId !== runId) return;
      const issue = workflowIssue(
        "ingest",
        localController?.signal.aborted ? new Error("stopped") : err,
      );
      const cancelled =
        issue.status === "stopped" || String(err).includes("cancelled");
      set((st) => ({
        finishedAt: Date.now(),
        stage: cancelled ? "cancelled" : "error",
        workflowStatus: issue.status,
        workflowIssues: [issue],
        cancelledAt: cancelled ? "run" : null,
        seen: false,
        log: cancelled ? st.log : `${st.log}\n\nERROR: ${String(err)}`,
      }));
    } finally {
      unsubscribeLocalVault?.();
      if (activeLocalIngest?.runId === runId) activeLocalIngest = null;
      // The run is over (done / error / cancelled / no-op early return).
      // Drop the claude-stream subscription so it does not outlive the run.
      // A fresh run re-subscribes via startStreamListener().
      //
      // Only the run that still owns the store may unsubscribe: the listener is
      // shared, so a superseded run tearing it down would leave the survivor
      // streaming into nothing. Unreachable now that the guard is atomic, but
      // the listener's lifetime should not depend on that.
      if (get().runId === runId) await stopStreamListener();
    }
  },

  resolvePlanGate(sel: boolean[]) {
    planGateResolver?.(sel);
  },

  skipPlanGate() {
    planGateResolver?.(defaultSelection(get().plan));
  },

  cancelIngest() {
    const { runId, stage } = get();
    if (stage === "plan-gate") {
      // No agent is running yet — resolving null makes startIngest end the
      // run at "cancelled" instead of killing a nonexistent claude run.
      planGateResolver?.(null);
      return;
    }
    if (!runId || stage !== "claude") return;
    if (activeLocalIngest?.runId === runId) {
      activeLocalIngest.controller.abort();
      return;
    }
    // Backend kill makes claude_run_stream reject with "cancelled";
    // startIngest's catch handler then flips the stage.
    void ipc.claudeCancel(runId);
  },

  markSeen: () => set({ seen: true }),

  bumpInboxRev: () => set((st) => ({ inboxRev: st.inboxRev + 1 })),

  reset: () => {
    if (activeLocalIngest?.runId === get().runId)
      activeLocalIngest.controller.abort();
    set({
      stage: "idle",
      workflowStatus: null,
      workflowIssues: [],
      sourceChunksPending: 0,
      log: "",
      events: [],
      touched: [],
      changedPages: [],
      readCount: 0,
      writeCount: 0,
      model: null,
      runId: null,
      startedAt: null,
      finishedAt: null,
      gateAt: null,
      sourceText: "",
      reportPath: null,
      candidates: [],
      plan: [],
      refusal: null,
      cancelledAt: null,
      gated: false,
      liveAdjacency: null,
      seen: true,
    });
  },
}));

/** How long the run has worked, in ms: up to now while it runs, up to its
 *  end once over, and up to the gate's opening while the gate is open or
 *  was cancelled (UX S35 — a clock counting at the gate read as loading). */
export function runElapsedMs(
  s: Pick<IngestState, "stage" | "startedAt" | "finishedAt" | "gateAt">,
  now: number,
): number {
  if (s.startedAt === null) return 0;
  if (s.gateAt !== null) return s.gateAt - s.startedAt;
  const live =
    s.stage === "writing-raw" || s.stage === "claude" || s.stage === "indexing";
  if (live) return now - s.startedAt;
  return s.finishedAt !== null ? s.finishedAt - s.startedAt : 0;
}

// Pending plan-gate resolver (one gate at a time — the store runs one ingest at
// a time). Set while startIngest awaits the review; `boolean[]` proceeds with
// that selection, `null` ends the run at "cancelled".
let planGateResolver: ((sel: boolean[] | null) => void) | null = null;

// Persist a finished streamed run to runs/<date>-<id>.log (opt-in, best effort).
// Reconstructs the transcript from the accumulated stream events plus the final
// model output. Never throws — a log-write failure must not fail the run.
async function persistRunTranscript(
  vaultPath: string,
  runId: string,
  finalOutput: string,
): Promise<void> {
  const events = useIngestStore.getState().events;
  const streamed = events
    .map((e) => e.text ?? (e.tool ? `[${e.tool}] ${e.detail ?? ""}` : ""))
    .filter(Boolean)
    .join("");
  const transcript = `${streamed}\n\n${finalOutput}`.trim();
  const name = `${new Date().toISOString().slice(0, 10)}-${runId}.log`;
  try {
    await ipc.writeRunLog(vaultPath, name, transcript);
    log.info("run_log.written", { feature: "ingest", path: `runs/${name}` });
  } catch (err) {
    log.warn("run_log.write_failed", {
      feature: "ingest",
      error: String(err),
    });
  }
}

// --- claude-stream listener (scoped to an active run) ---------------------
//
// The listener is subscribed when a run starts and unsubscribed when it ends
// (startIngest's finally block), so it never outlives the run that needs it.
// `subscribing` holds the in-flight listen() promise so start/stop can never
// double-register or tear down while a subscribe is mid-flight.

type UnlistenFn = () => void;

let unlistenStream: UnlistenFn | null = null;
let subscribing: Promise<UnlistenFn> | null = null;

async function startStreamListener(): Promise<void> {
  // Already subscribed or a subscribe is in flight — reuse it.
  if (unlistenStream || subscribing) {
    await subscribing;
    return;
  }
  subscribing = listen<ClaudeStreamPayload>("claude-stream", (e) => {
    const st = useIngestStore.getState();
    if (!st.runId || e.payload.run_id !== st.runId) return;
    applyStreamEvent(e.payload);
  });
  try {
    unlistenStream = await subscribing;
  } finally {
    subscribing = null;
  }
}

async function stopStreamListener(): Promise<void> {
  // If a subscribe is still resolving, wait for the handle before dropping it,
  // otherwise the listener would leak.
  if (subscribing) {
    try {
      await subscribing;
    } catch {
      /* subscribe failed — nothing to tear down */
    }
  }
  if (unlistenStream) {
    unlistenStream();
    unlistenStream = null;
  }
}

// Self-paced link-graph rescan after streamed writes. Write tool events fire
// when the call STARTS, so wait ~2s for the file to land on disk. Rust
// resolves wikilinks by stem against current disk state — files created
// mid-run resolve correctly.
//
// Self-paced, not debounced: the next scan starts 2s AFTER the previous one
// finished, so a burst of writes queues exactly one follow-up instead of
// either overlapping scans or (with a reset-on-every-event debounce) never
// scanning at all during a busy run.
const SCAN_GAP_MS = 2000;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let scanInFlight = false;
let scanQueued = false;
// Last applied graph, per run: a new run resets liveAdjacency to null, so the
// rev only means "already showing this" within the same runId.
let lastScan: { runId: string | null; rev: number } | null = null;

function scheduleLiveScan(): void {
  if (scanInFlight) {
    scanQueued = true;
    return;
  }
  if (scanTimer != null) return;
  // Bare setTimeout, not window.setTimeout: identical in the browser, and it
  // lets the node-environment unit tests drive this loop with fake timers.
  scanTimer = setTimeout(() => {
    scanTimer = null;
    void runLiveScan();
  }, SCAN_GAP_MS);
}

async function runLiveScan(): Promise<void> {
  const st = useIngestStore.getState();
  if (!st.vaultPath || st.stage !== "claude") return;
  scanInFlight = true;
  try {
    const adj = await ipc.buildLinkGraph(st.vaultPath);
    // Run may have finished or been reset while scanning.
    // Skip the write when the graph is byte-identical: a fresh object identity
    // every scan rebuilds the whole MiniGalaxy for nothing.
    if (
      useIngestStore.getState().runId === st.runId &&
      (adj.rev == null ||
        lastScan?.runId !== st.runId ||
        lastScan.rev !== adj.rev)
    ) {
      lastScan = adj.rev == null ? null : { runId: st.runId, rev: adj.rev };
      useIngestStore.setState({ liveAdjacency: adj });
    }
  } catch {
    /* scan failed — the next write event retries */
  } finally {
    scanInFlight = false;
    if (scanQueued) {
      scanQueued = false;
      scheduleLiveScan();
    }
  }
}

let eventSeq = 0;

// Exported for the unit test — production callers go through the
// `claude-stream` listener above.
export function applyStreamEvent(p: ClaudeStreamPayload): void {
  useIngestStore.setState((st) => {
    const ev: IngestEvent = {
      seq: ++eventSeq,
      at: Date.now(),
      kind: p.kind,
      tool: p.tool ?? undefined,
      detail: p.detail ? relativize(p.detail, st.vaultPath) : undefined,
      text: p.text ?? undefined,
    };
    const next: Partial<IngestState> = {
      // Cap the feed so a pathological run cannot grow memory unbounded.
      events: [...st.events.slice(-499), ev],
    };
    if (p.kind === "init" && p.text) next.model = p.text;
    if (p.kind === "tool" && p.tool && ev.detail) {
      const isWrite = WRITE_TOOLS.has(p.tool);
      const isRead = p.tool === "Read";
      if (isWrite) scheduleLiveScan();
      if (isWrite || isRead) {
        if (isWrite) next.writeCount = st.writeCount + 1;
        else next.readCount = st.readCount + 1;
        // `next.touched` is left unset unless the list actually changes, so
        // subscribers that only watch `touched` (mini graph, PageGraph glow)
        // keep the old array identity and do not re-render per event.
        const existing = st.touched.find((f) => f.path === ev.detail);
        if (existing) {
          if (isWrite && !existing.write) {
            next.touched = st.touched.map((f) =>
              f.path === ev.detail ? { ...f, write: true } : f,
            );
          }
        } else {
          next.touched = [...st.touched, { path: ev.detail, write: isWrite }];
        }
      }
    }
    return next;
  });
}
