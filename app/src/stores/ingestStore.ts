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
import type { Adjacency, CandidatePage, ClaudeStreamPayload } from "../lib/ipc";
import { complete } from "../lib/chat";
import { buildIngestPlanPrompt, parseIngestPlan } from "../lib/ingestPlan";
import type { PlanItem } from "../lib/ingestPlan";
import { defaultSelection, selectedPlan } from "../lib/planGate";
import { loadProfile } from "../lib/profile";
import { log } from "../lib/log";
import { STRINGS } from "../lib/i18n";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";

// This store logs plain user-facing text (not JSX), so it reads the current
// language directly off uiStore rather than taking a `Strings` prop like
// components do.
function t() {
  return STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
}

export type IngestStage =
  | "idle"
  | "writing-raw"
  | "plan-gate"
  | "claude"
  | "indexing"
  | "done"
  | "cancelled"
  | "error";

export interface IngestEvent {
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
// a second hand-maintained copy.
export const INGEST_PROMPT = (
  slug: string,
  title: string,
  candidates: CandidatePage[] = [],
  plan: PlanItem[] = [],
  profileInterests = "",
) =>
  `New source has been added at \`raw/${slug}.md\` (title: "${title}"). Please ingest it into the wiki following the workflow in CLAUDE.md:

1. Read the source completely.
2. Identify pages it affects (entities, concepts, techniques, analyses).
3. Update existing pages with inline citations, or create new pages with required frontmatter.
4. Create the source-summary page \`wiki/source-${slug}.md\`.
5. Update \`wiki/index.md\` and append a \`wiki/log.md\` entry.
6. Write an ingest report at \`ingest-reports/<datetime>-${slug}.md\` summarising what was created/modified and why.${groundingBlock(plan, candidates)}${interestsLine(profileInterests)}

When done, output a one-line confirmation.`;

/** Args for the two non-streaming provider branches (see `runIngestProvider`'s
 * own doc comment for why the third — anthropic-cli — is not here too). */
export interface IngestProviderArgs {
  provider: string;
  vaultPath: string;
  prompt: string;
  slug: string;
  title: string;
  body: string;
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
  if (args.provider === "myco-pro") {
    // myco Pro: the proxy runs a cheap model server-side and returns the wiki
    // file operations, which Rust applies (confined). No tool stream.
    const result = await ipc.mycoProIngest(args.slug, args.title, args.body);
    return `${result.summary}\n\n(${result.applied} wiki file${
      result.applied === 1 ? "" : "s"
    } updated via myco Pro)`;
  }
  // Other providers (gemini/codex CLIs, HTTP APIs, ollama) have no tool-event
  // stream; blocking call.
  return complete({
    task: "ingest",
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

interface IngestState {
  stage: IngestStage;
  log: string;
  events: IngestEvent[];
  touched: TouchedFile[];
  readCount: number;
  writeCount: number;
  model: string | null;
  runId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
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
  /** `headless: true` skips the plan gate — unattended callers (autoIngest's
   * inbox pass) have nobody at the wheel and would hang on it forever. */
  startIngest: (
    title: string,
    body: string,
    opts?: { headless?: boolean },
  ) => Promise<void>;
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

export const useIngestStore = create<IngestState>((set, get) => ({
  stage: "idle",
  log: "",
  events: [],
  touched: [],
  readCount: 0,
  writeCount: 0,
  model: null,
  runId: null,
  startedAt: null,
  finishedAt: null,
  reportPath: null,
  vaultPath: null,
  candidates: [],
  plan: [],
  liveAdjacency: null,
  seen: true,
  inboxRev: 0,

  async startIngest(title: string, body: string, opts?: { headless?: boolean }) {
    const vault = useVaultStore.getState().currentVault;
    if (!vault) return;
    const s = get();
    if (
      s.stage === "writing-raw" ||
      s.stage === "plan-gate" ||
      s.stage === "claude" ||
      s.stage === "indexing"
    )
      return; // one run at a time

    const finalTitle = title.trim() || `untitled-${Date.now()}`;
    // Provisional slug for the log line before the run is claimed. The effective
    // one is resolved below against the filesystem, since raw/ is immutable and a
    // same-titled re-ingest must land on its own path, not overwrite the first.
    let slug = slugify(finalTitle);
    const runId = crypto.randomUUID();

    // Claim the run before awaiting anything. `listen()` is async, so the guard
    // above and this set() would otherwise straddle a microtask boundary and
    // two callers in the same tick would both start an agent — runInboxPass has
    // two triggers (clip-saved, interval) that arrive through identical IPCs.
    set({
      stage: "writing-raw",
      log: `Writing raw/${slug}.md…`,
      events: [],
      touched: [],
      readCount: 0,
      writeCount: 0,
      model: null,
      runId,
      startedAt: Date.now(),
      finishedAt: null,
      reportPath: null,
      vaultPath: vault.path,
      candidates: [],
      plan: [],
      liveAdjacency: null,
      seen: true,
    });
    await startStreamListener();

    try {
      try {
        await ipc.createFolder(vault.path, "raw");
      } catch {
        /* already exists */
      }
      // Resolve a free raw/ path so a second source under the same title gets its
      // own original instead of overwriting the first (which the command layer
      // now refuses outright). Fall back to the provisional slug if the lookup
      // fails, so ingest still proceeds.
      const rawRel = await ipc
        .availableRawPath(slug)
        .catch(() => `raw/${slug}.md`);
      slug = rawRel.replace(/^raw\//, "").replace(/\.md$/, "");
      set({ log: `Writing ${rawRel}…` });
      const payload =
        body.trim().length > 0
          ? `# ${finalTitle}\n\n${body.trim()}\n`
          : `# ${finalTitle}\n\n_(empty)_\n`;
      await ipc.writeFile(`${vault.path}/${rawRel}`, payload);
      await useVaultStore.getState().refreshTree();

      // Snapshot wiki/ mtimes before the model runs so we can verify it
      // actually wrote something, rather than reporting success for a no-op.
      const wikiBefore = new Map(
        (await ipc.fileMtimes(vault.path).catch(() => []))
          .filter(([p]) => p.includes("/wiki/"))
          .map(([p, m]) => [p, m] as const),
      );

      // Retrieval grounding: find existing pages this source likely relates to
      // so the prompt tells the agent to update them, not duplicate. Best-effort
      // — an absent/stale vector index yields none and ingest proceeds unchanged.
      const candidates = await ipc
        .wikifyCandidates(body.trim(), 8)
        .catch(() => [] as CandidatePage[]);
      set({ candidates });

      // Phase 2: one read-only planning call turns the source + candidates into
      // explicit ADD/UPDATE/MERGE/NOOP decisions, shown as telemetry and fed to
      // the writing agent. Best-effort — a failure or unparseable reply leaves
      // the plan empty and the prompt falls back to candidate grounding.
      let plan: PlanItem[] = [];
      try {
        const planReply = await complete({
          task: "generate",
          cwd: vault.path,
          messages: [
            {
              role: "user",
              content: buildIngestPlanPrompt(body.trim(), candidates),
            },
          ],
        });
        plan = parseIngestPlan(planReply);
      } catch {
        /* planner unavailable — proceed with candidate grounding only */
      }
      set({ plan });

      // Plan gate (Q4 item 7): pause a manual run for a per-item checkbox
      // review before the writing agent touches the wiki. Headless callers
      // (autoIngest's inbox pass) skip it — nobody is watching, and an
      // unresolved gate would park the run (and block future passes) forever.
      // fullTierIngest.ts never reaches here at all: it builds INGEST_PROMPT
      // directly and does not call startIngest.
      if (plan.length > 0 && !opts?.headless) {
        set({ stage: "plan-gate" });
        const sel = await new Promise<boolean[] | null>((res) => {
          planGateResolver = res;
        });
        planGateResolver = null;
        if (sel === null) {
          // Cancelled at the gate — nothing has run yet; back to the form.
          // The raw/ copy already written stays (raw/ is immutable); the
          // finally block below drops the stream listener.
          set({ stage: "idle" });
          return;
        }
        plan = selectedPlan(plan, sel);
        set({ plan });
      }

      set({ stage: "claude" });
      const settings = await ipc.getSettings();
      // Phase B, Task 6: weight linking/tagging toward the user's stated
      // interests — a lighter grounding line than chat.ts's full profile
      // paragraph, but sent to the same configured provider, so it is
      // governed by the same `profile_injection` toggle (review-caught: the
      // brief's "when a profile exists" wording missed the master spec's
      // privacy principle that the toggle covers every path that sends
      // profile content to a provider). Fail CLOSED on a config-read error —
      // omit the line rather than risk leaking interests past a toggle we
      // couldn't confirm is on.
      const distillCfg = await ipc.getDistillConfig(vault.path).catch(() => null);
      const profile = distillCfg?.profile_injection
        ? await loadProfile(vault.path)
        : null;
      const prompt = INGEST_PROMPT(
        slug,
        finalTitle,
        candidates,
        plan,
        profile?.interests.join(", ") ?? "",
      );
      let out: string;
      if (settings.ingest_provider === "anthropic-cli") {
        // Pass the chosen model (e.g. "haiku") so ingest can run on a cheaper
        // model; empty -> the CLI's configured default.
        const res = await ipc.claudeRunStream(
          runId,
          prompt,
          vault.path,
          settings.ingest_model || undefined,
          settings.ingest_effort,
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
          provider: settings.ingest_provider,
          vaultPath: vault.path,
          prompt,
          slug,
          title: finalTitle,
          body: body.trim(),
        });
      }
      set((st) => ({ log: `${st.log}\n\n${out}` }));

      set({ stage: "indexing" });
      await useVaultStore.getState().refreshTree();
      await useVaultStore.getState().refreshLinkGraph();

      // Verify the wiki changed: a new wiki page appeared or an existing one
      // was modified. If nothing changed, the model replied but did not ingest.
      const afterMtimes = await ipc.fileMtimes(vault.path).catch(() => []);
      // ipc.fileMtimes returns absolute filesystem paths, but validateIngest
      // (Rust validate_pages) requires vault-relative paths — its loop does
      // `if !rel.starts_with("wiki/")` and silently skips anything else, so an
      // un-relativized path here makes the validator a silent no-op.
      const changed = afterMtimes
        .filter(
          ([p, m]) =>
            p.includes("/wiki/") &&
            (!wikiBefore.has(p) || m > (wikiBefore.get(p) ?? 0)),
        )
        .map(([p]) => relativize(p, vault.path));
      if (changed.length === 0) {
        set((st) => ({
          finishedAt: Date.now(),
          stage: "error",
          seen: false,
          log: `${st.log}\n\n${(
            t().ingest_no_changes ??
            "WARNING: the model finished but no wiki pages were created or " +
              "updated. The source was saved to raw/{slug}.md, but nothing " +
              "was ingested into the wiki. Check the model output above, or " +
              "try the Claude Code (CLI) provider."
          ).replace("{slug}", slug)}`,
        }));
        return;
      }

      // Deterministic validator (Phase 1f): dangling citations / missing
      // required frontmatter / invalid enums fail the ingest outright;
      // unresolved wikilinks / source_count mismatch / missing superseded_by
      // are reported but do not block. Best-effort — a validator failure
      // (e.g. IPC error) must not itself fail an otherwise-good ingest.
      const vr = await ipc.validateIngest(vault.path, changed).catch((err) => {
        // Fail open (a validator-IPC error must not itself fail an otherwise-
        // good ingest), but log it — silently swallowing this would let a
        // broken validator call disable the gate with no trace.
        log.warn("validate_ingest.failed", {
          feature: "ingest",
          error: String(err),
        });
        return null;
      });
      if (vr && vr.errors.length > 0) {
        const lines = vr.errors.map((e) => `- ${e.page}: ${e.detail}`).join("\n");
        set((st) => ({
          finishedAt: Date.now(),
          stage: "error",
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
        finishedAt: Date.now(),
        stage: "done",
        seen: false,
        log: `${st.log}${warnLines}`,
      }));
    } catch (err) {
      const cancelled = String(err).includes("cancelled");
      set((st) => ({
        finishedAt: Date.now(),
        stage: cancelled ? "cancelled" : "error",
        seen: false,
        log: cancelled ? st.log : `${st.log}\n\nERROR: ${String(err)}`,
      }));
    } finally {
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
      // No agent is running yet — resolving null makes startIngest abort
      // cleanly back to idle instead of killing a nonexistent claude run.
      planGateResolver?.(null);
      return;
    }
    if (!runId || stage !== "claude") return;
    // Backend kill makes claude_run_stream reject with "cancelled";
    // startIngest's catch handler then flips the stage.
    void ipc.claudeCancel(runId);
  },

  markSeen: () => set({ seen: true }),

  bumpInboxRev: () => set((st) => ({ inboxRev: st.inboxRev + 1 })),

  reset: () =>
    set({
      stage: "idle",
      log: "",
      events: [],
      touched: [],
      readCount: 0,
      writeCount: 0,
      model: null,
      runId: null,
      startedAt: null,
      finishedAt: null,
      reportPath: null,
      candidates: [],
      plan: [],
      liveAdjacency: null,
      seen: true,
    }),
}));

// Pending plan-gate resolver (one gate at a time — the store runs one ingest at
// a time). Set while startIngest awaits the review; `boolean[]` proceeds with
// that selection, `null` aborts the run back to idle.
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

// Debounced link-graph rescan after streamed writes. Write tool events fire
// when the call STARTS, so wait ~2s for the file to land on disk. Rust
// resolves wikilinks by stem against current disk state — files created
// mid-run resolve correctly.
let scanTimer: number | null = null;
let scanInFlight = false;

function scheduleLiveScan(): void {
  if (scanTimer != null) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    void runLiveScan();
  }, 2000);
}

async function runLiveScan(): Promise<void> {
  const st = useIngestStore.getState();
  if (!st.vaultPath || st.stage !== "claude") return;
  if (scanInFlight) {
    scheduleLiveScan();
    return;
  }
  scanInFlight = true;
  try {
    const adj = await ipc.buildLinkGraph(st.vaultPath);
    // Run may have finished or been reset while scanning.
    if (useIngestStore.getState().runId === st.runId) {
      useIngestStore.setState({ liveAdjacency: adj });
    }
  } catch {
    /* scan failed — the next write event retries */
  } finally {
    scanInFlight = false;
  }
}

function applyStreamEvent(p: ClaudeStreamPayload): void {
  useIngestStore.setState((st) => {
    const ev: IngestEvent = {
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
