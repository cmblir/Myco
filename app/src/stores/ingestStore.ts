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
import type { Adjacency, ClaudeStreamPayload } from "../lib/ipc";
import { complete } from "../lib/chat";
import { log } from "../lib/log";
import { useVaultStore } from "./vaultStore";

export type IngestStage =
  | "idle"
  | "writing-raw"
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

const INGEST_PROMPT = (slug: string, title: string) =>
  `New source has been added at \`raw/${slug}.md\` (title: "${title}"). Please ingest it into the wiki following the workflow in CLAUDE.md:

1. Read the source completely.
2. Identify pages it affects (entities, concepts, techniques, analyses).
3. Update existing pages with inline citations, or create new pages with required frontmatter.
4. Create the source-summary page \`wiki/source-${slug}.md\`.
5. Update \`wiki/index.md\` and append a \`wiki/log.md\` entry.
6. Write an ingest report at \`ingest-reports/<datetime>-${slug}.md\` summarising what was created/modified and why.

When done, output a one-line confirmation.`;

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
  /** Fresh link graph rescanned (debounced) after each streamed write, so
   * live views (mini graph, galaxy growth) see edges of pages created
   * mid-run. Never written to vaultStore.adjacency — that would tear down
   * the graph page renderer. */
  liveAdjacency: Adjacency | null;
  /** false after a run finishes until the user visits the Ingest page —
   * drives the "done/failed" Topbar chip. */
  seen: boolean;
  startIngest: (title: string, body: string) => Promise<void>;
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
  liveAdjacency: null,
  seen: true,

  async startIngest(title: string, body: string) {
    const vault = useVaultStore.getState().currentVault;
    if (!vault) return;
    const s = get();
    if (
      s.stage === "writing-raw" ||
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

      set({ stage: "claude" });
      const settings = await ipc.getSettings();
      const prompt = INGEST_PROMPT(slug, finalTitle);
      let out: string;
      if (settings.ingest_provider === "anthropic-cli") {
        // Pass the chosen model (e.g. "haiku") so ingest can run on a cheaper
        // model; empty -> the CLI's configured default.
        const res = await ipc.claudeRunStream(
          runId,
          prompt,
          vault.path,
          settings.ingest_model || undefined,
        );
        if (res.status !== 0) {
          throw new Error(res.stderr.trim() || `claude exit ${res.status}`);
        }
        out = res.stdout.trim();
        // Opt-in persistence: the streamed run accumulated a transcript in
        // `events` — write it to runs/ alongside the final output.
        await persistRunTranscript(vault.path, runId, out);
      } else if (settings.ingest_provider === "memex-pro") {
        // Memex Pro: the proxy runs a cheap model server-side and returns the
        // wiki file operations, which Rust applies (confined). The raw source
        // was already written above; this fills in the wiki pages. No tool
        // stream — stage UI only.
        const result = await ipc.memexProIngest(slug, finalTitle, body.trim());
        out = `${result.summary}\n\n(${result.applied} wiki file${
          result.applied === 1 ? "" : "s"
        } updated via Memex Pro)`;
      } else {
        // Other providers (gemini/codex CLIs, HTTP APIs, ollama) have no
        // tool-event stream; blocking call, stage UI only.
        out = await complete({
          task: "ingest",
          cwd: vault.path,
          messages: [{ role: "user", content: prompt }],
        });
      }
      set((st) => ({ log: `${st.log}\n\n${out}` }));

      set({ stage: "indexing" });
      await useVaultStore.getState().refreshTree();
      await useVaultStore.getState().refreshLinkGraph();

      // Verify the wiki changed: a new wiki page appeared or an existing one
      // was modified. If nothing changed, the model replied but did not ingest.
      const afterMtimes = await ipc.fileMtimes(vault.path).catch(() => []);
      const wikiChanged = afterMtimes.some(
        ([p, m]) =>
          p.includes("/wiki/") &&
          (!wikiBefore.has(p) || m > (wikiBefore.get(p) ?? 0)),
      );
      if (!wikiChanged) {
        set((st) => ({
          finishedAt: Date.now(),
          stage: "error",
          seen: false,
          log:
            `${st.log}\n\nWARNING: the model finished but no wiki pages were ` +
            `created or updated. The source was saved to raw/${slug}.md, but ` +
            `nothing was ingested into the wiki. Check the model output above, ` +
            `or try the Claude Code (CLI) provider.`,
        }));
        return;
      }

      // Open the report the model actually wrote (newest matching file),
      // instead of guessing the filename from today's date.
      const report = afterMtimes
        .filter(
          ([p]) => p.includes("/ingest-reports/") && p.endsWith(`-${slug}.md`),
        )
        .sort((a, b) => b[1] - a[1])[0];
      set({
        reportPath: report ? report[0] : null,
        finishedAt: Date.now(),
        stage: "done",
        seen: false,
      });
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

  cancelIngest() {
    const { runId, stage } = get();
    if (!runId || stage !== "claude") return;
    // Backend kill makes claude_run_stream reject with "cancelled";
    // startIngest's catch handler then flips the stage.
    void ipc.claudeCancel(runId);
  },

  markSeen: () => set({ seen: true }),

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
      liveAdjacency: null,
      seen: true,
    }),
}));

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
