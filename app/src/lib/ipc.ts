// Type-safe wrappers around Tauri invoke calls. Keep this file thin: it must
// reflect the Rust command signatures in src-tauri/src/commands.rs.

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  ArchiveTree,
  BucketUsage,
  DigestDay,
  DistillConfig,
  DistillStatus,
  PackReport,
  RestoreReport,
  RollupBucket,
  RunReport,
} from "./distill";
import type { QuarantineItem } from "./quarantine";

export interface VaultMeta {
  path: string;
  name: string;
}

export type FileNode =
  | { kind: "file"; name: string; path: string }
  | {
      kind: "directory";
      name: string;
      path: string;
      children: FileNode[];
    };

/** One file waiting in `_inbox/`, any extension (Q4 item 20a). */
export interface InboxEntry {
  name: string;
  /** Vault-relative path (`_inbox/<name>`). */
  rel: string;
  /** Lowercased extension without the dot; "" when the name has none. */
  ext: string;
  bytes: number;
  /** Epoch seconds; 0 when the mtime could not be read. */
  mtime: number;
}

export interface FileContent {
  path: string;
  /** Full unmodified file on disk. The editor edits and saves THIS so a
   *  read -> edit -> write round-trip preserves YAML frontmatter. */
  raw: string;
  /** Document body with leading YAML frontmatter stripped — preview only.
   *  Never write this back to disk; it would delete the frontmatter. */
  content: string;
  frontmatter: unknown;
}

/** Per-node wiki frontmatter the graph encodes visually (from index.rs). */
export interface NodeMeta {
  type?: string;
  confidence?: string;
  status?: string;
  sourceCount?: number;
}

export interface Adjacency {
  forward: Record<string, string[]>;
  backward: Record<string, string[]>;
  unresolved: Record<string, string[]>;
  tags: Record<string, string[]>;
  /** Keyed by the same absolute path as `forward`. Absent for older backends. */
  meta?: Record<string, NodeMeta>;
}

/** One registered project ("universe") from the multi-project registry. */
export interface ProjectInfo {
  slug: string;
  title: string;
  description: string;
  /** Absolute project root (`<registry root>/projects/<slug>`). */
  root: string;
  /** Markdown notes under the project root (graph-node approximation). */
  noteCount: number;
  created: string;
  lastUsed: string;
  independentVault: boolean;
  active: boolean;
}

export interface GitCommit {
  hash: string;
  date: string;
  subject: string;
  created: number;
  modified: number;
}

export interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

/** One parsed line from the panic log (crash.rs), oldest-first as returned. */
export interface PanicEntry {
  unix_secs: number;
  location: string;
  message: string;
  /** The untouched log line — what "Copy a bug report" pastes verbatim. */
  raw: string;
}

/// Native (in-process) MCP server info — no install, always running.
export interface McpNativeInfo {
  running: boolean;
  url: string;
  command: string;
  desktop_json: string;
}

export interface ClaudeResult {
  stdout: string;
  stderr: string;
  status: number;
}

/// One `claude-stream` Tauri event payload (see claude.rs StreamEvent).
export interface ClaudeStreamPayload {
  run_id: string;
  kind: "init" | "text" | "tool" | "result" | "raw";
  tool: string | null;
  detail: string | null;
  text: string | null;
}

export interface SourceRef {
  /** Raw stem (footnote id minus `src-`), e.g. "chatgpt-ab12". */
  slug: string;
  /** Vendor from the raw file's `source:` frontmatter, or "" if hand-authored. */
  kind: string;
  title: string | null;
  conversation_id: string | null;
  /** As written — an epoch (imported) or a date string (hand-authored). */
  created: string | null;
  /** False when no raw/<slug>.md backs the citation (a dangling source). */
  resolved: boolean;
}

export interface TaskItem {
  page: string;
  stem: string;
  line: number;
  text: string;
  /** True only for `[x]` — "is it finished", which most callers want. */
  done: boolean;
  /** The checkbox mark: `[ ]` `[/]` `[-]` `[x]`. Absent from older backends,
   *  where everything reads as todo/done. */
  status?: "todo" | "doing" | "blocked" | "done";
}

export interface ProvenanceRow {
  path: string;
  name: string;
  cited: number;
  total: number;
  /** Distinct sources this page cites, resolved to their raw provenance. */
  sources: SourceRef[];
}

/** One validator finding (deterministic ingest gate, replaces the mtime check). */
export interface ValidationIssue {
  page: string;
  kind: string;
  detail: string;
}

export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** The deterministic wiki lint's findings, tiered as the report renders them.
 *  Link gaps are NOT here — the UI derives those from the link graph. */
export interface LintReport {
  critical: ValidationIssue[];
  warning: ValidationIssue[];
  info: ValidationIssue[];
}

export interface SearchHit {
  path: string;
  name: string;
  line: number;
  snippet: string;
}

/** A semantic (embedding) search hit. `page` is the vault-relative path. */
export interface VecHit {
  page: string;
  stem: string;
  section: number;
  score: number;
}

/** A semantic search hit with its matching chunk's text reconstructed
 * server-side — what `semantic_search` returns (unlike `related_pages`,
 * which stays a bare `VecHit`: it has no single query chunk to attach text
 * to). */
export interface ScoredChunk {
  page: string;
  stem: string;
  section: number;
  text: string;
  /** Rank-based fusion score (RRF). Orders hits; says NOTHING about whether a
   *  hit is relevant — a nonsense query's top hit scores like a perfect
   *  match's. Use `similarity` to judge relevance. */
  score: number;
  /** True dense cosine similarity, carried through fusion. `null` when the
   *  chunk came only from the lexical arm. See RELEVANCE_FLOOR in chat.ts. */
  similarity: number | null;
}

/** A dormant wiki page whose content echoes the day's seed text — what
 * `resurface_candidates` returns (Q4 item 10). */
export interface ResurfaceCandidate {
  page: string;
  stem: string;
  /** Cosine between the seed and the page's best chunk. */
  score: number;
  /** Best-matching chunk's text, trimmed to 240 chars. */
  snippet: string;
  /** Unix secs of the last recorded open; null = never recorded. */
  last_open: number | null;
}

export interface SemanticPoint {
  page: string;
  x: number;
  y: number;
  z: number;
}

export interface CandidatePage {
  page: string;
  stem: string;
  score: number;
}

export interface EmbeddingsStatus {
  indexed_pages: number;
  model: string;
}

/** Result of importing one or many conversation exports into `_inbox/`. */
export interface ImportOutcome {
  /** Detected format: chatgpt | claude-code | codex | unknown. */
  source: string;
  /** How many source docs were written to `_inbox/`. */
  imported: number;
  /** Conversations already imported unchanged (dedup ledger). */
  skipped: number;
  /** Conversations skipped because their text matched a secret pattern. */
  quarantined: { title: string; secrets: string[] }[];
  /** Files that could not be read/parsed — retryable via importPaths. */
  failed: { path: string; error: string }[];
}

/** Progress of a running import (file counts + running tallies). */
export interface ImportProgress {
  done: number;
  total: number;
  file: string;
  imported: number;
  skipped: number;
  failed: number;
}

/** A semantic-similarity edge for the graph overlay (absolute page paths). */
export interface SemEdge {
  source: string;
  target: string;
  score: number;
}

/** Counts behind the Ingest page's session-backfill card. */
export interface BackfillStatus {
  total: number;
  promoted: number;
  eligible: number;
  too_small: number;
  /** Held, not hidden — sessions past the per-run size ceiling. */
  too_large: number;
}

export interface BackfillPromotion {
  /** `_inbox/` names that now hold a copy. */
  promoted: string[];
  remaining: number;
}

export interface MycoSettings {
  providers: {
    anthropic_cli: boolean;
    gemini_cli: boolean;
    codex_cli: boolean;
    anthropic_api: boolean;
    openai_api: boolean;
    google_api: boolean;
    ollama: boolean;
    openrouter: boolean;
    myco_pro: boolean;
    /** Embedded model (bundled GGUF) — ships in the app, on by default. */
    builtin_local: boolean;
  };
  query_provider: string;
  query_model: string;
  ingest_provider: string;
  ingest_model: string;
  /** Reasoning effort per role, or the "(default)" sentinel meaning "pass no
   *  effort flag". Only the CLIs that expose one use it (claude `--effort`,
   *  codex `-c model_reasoning_effort=`). */
  query_effort: string;
  ingest_effort: string;
  /** myco Pro proxy base URL (the subscription ingest endpoint). */
  myco_pro_url: string;
  /** The myco Pro account email the app is logged in as (display only). */
  myco_pro_email: string;
  /** Periodically sweep local CLI session logs (Claude Code / Codex) into
   *  _inbox/ while the app is open — no hooks or manual harness needed. */
  auto_import_enabled: boolean;
  auto_import_interval_min: number;
  /** Periodically ingest pending _inbox/ sources while the app is open. */
  auto_ingest_enabled: boolean;
  auto_ingest_interval_min: number;
  /** Periodically run a read-only reflect pass while the app is open. */
  auto_reflect_enabled: boolean;
  auto_reflect_interval_min: number;
  /** Re-embed changed pages while the app is open (maintains an existing index
   *  only; the first build stays a deliberate action). */
  auto_reindex_enabled: boolean;
  /** Keep the menu bar tray (and the app) running after the window closes.
   *  Default OFF: closing the window quits, as it always did. */
  tray_resident: boolean;
  /** Global shortcut that opens the spotlight ask window ("Alt+Space"), or an
   *  empty string when the feature is switched off. Whether the OS actually
   *  granted it is runtime state — see `ipc.spotlightStatus`. */
  spotlight_shortcut: string;
  /** Q4 item 1 — opt-in local git history for the open vault. */
  vault_history_enabled: boolean;
  /** Q4 item 13 — when on, PII-bearing content is refused/quarantined on
   *  every raw/ entry path instead of written with a warning. */
  pii_quarantine_enabled: boolean;
  /** Menu-bar notch drop surface (macOS). Default OFF — a panel over the menu
   *  bar is opt-in. update_notch_enabled PERSISTS the flag itself and
   *  creates/destroys the window — do not also route it through set_settings
   *  (two writers of the same file). */
  notch_enabled: boolean;
}

/** Mirrors Rust `commands::SecretScanReport` (Q4 item 13) — pattern names,
 *  never the matched text. */
export interface SecretScanReport {
  secrets: string[];
  pii: string[];
}

/** Mirrors Rust `commands::RawAuditHit` (Q4 item 14) — one flagged raw/ file. */
export interface RawAuditHit {
  rel: string;
  /** Pattern names only — the matched text never leaves the scan. */
  patterns: string[];
  /** File exists only in git history — nothing left on disk to open. */
  in_history_only: boolean;
}

/** Mirrors Rust `commands::RawAuditReport` (Q4 item 14) — read-only audit. */
export interface RawAuditReport {
  files_scanned: number;
  history_files_scanned: number;
  secret_hits: RawAuditHit[];
  pii_hits: RawAuditHit[];
  truncated: boolean;
}

/** Mirrors Rust `vault_history::HistoryStatus` (Q4 item 1). */
export interface VaultHistoryStatus {
  git_present: boolean;
  enabled: boolean;
}

/** Mirrors Rust `vault_history::PageAuthorship` (Q4 item 16). */
export interface PageAuthorship {
  agent_lines: number;
  human_lines: number;
  last_human_at: number | null;
}

/** wiki/ rel -> ever committed by the agent author (Q4 item 16). Aliased:
 *  a nested generic inside `invoke<…>` defeats the parity test's cheap regex. */
export type AuthorshipIndex = Record<string, boolean>;

/** Mirrors Rust `mcp_native::SuspectPage` (Q4 item 2). */
export interface SuspectPage {
  page: string;
  reasons: string[];
}

/** Mirrors Rust `mcp_native::SuspectReport` (Q4 item 2). */
export interface SuspectReport {
  pages_checked: number;
  suspects: SuspectPage[];
}

/** Mirrors Rust `distill::RunSummary` (Q4 item 3). */
export interface RunSummary {
  id: string;
  started_at: number;
  moves: number;
  trashed: number;
  created: number;
}

/** Mirrors Rust `distill::RunDetail` (W3–6 item 6). */
export interface RunDetail {
  id: string;
  started_at: number;
  moves: [string, string][];
  trashed: [string, string][];
  created: string[];
  report_rel: string | null;
  commit: string | null;
}

/** Mirrors Rust `commands::FileDiff` (W3–6 item 6). Both sides null when the
 *  file is too large to diff (status still tells what happened). */
export interface FileDiff {
  path: string;
  status: string; // "added" | "modified" | "renamed" | "deleted"
  before: string | null;
  after: string | null;
}

/** Honest global-shortcut state (mirrors Rust `spotlight::ShortcutStatus`).
 *  `registered: false` with a non-empty `shortcut` means the app asked for it
 *  and was refused — `error` carries the reason, shown as-is in Settings. */
export interface SpotlightStatus {
  shortcut: string;
  registered: boolean;
  error: string | null;
}

/** macOS notch metrics in AppKit points (mirrors Rust `notch::NotchGeometry`).
 *  `has_notch: false` — an external display or a pre-2021 Mac — leaves the two
 *  notch dimensions at 0; only `screen_w` is meaningful then. */
export interface NotchGeometry {
  has_notch: boolean;
  notch_w: number;
  notch_h: number;
  screen_w: number;
}

/** Pre-translated tray snapshot (mirrors Rust tray::TrayStatus). The Rust
 *  side stores strings only — it owns no translations. */
/** One running activity row; `kind` picks the native menu row icon. */
export interface TrayRunningRow {
  kind: "ask" | "distill" | "reflect" | "index";
  text: string;
}

/** What arrived in the vault today (Rust `inflow_stats`). "Today" is the
 *  caller's local date; the MCP counter is in-memory, so after a restart it
 *  counts since app launch — label it as such. */
/** One local day's arrivals by channel — mirrors Rust `inflow_log::InflowDay`. */
export interface InflowDay {
  day: string; // YYYY-MM-DD
  mcp: number;
  clipper: number;
  voice: number;
  import: number;
}

export interface InflowStats {
  /** sessions/<month>/*.md written (swept) today, by mtime. */
  sessionsToday: number;
  /** Top-level _inbox/ files created today (birthtime, mtime fallback). */
  inboxToday: number;
  /** Today's _inbox arrivals by frontmatter `source:` — `unknown` for files
   *  that carry none (legacy docs, hand-dropped notes). Never guessed. */
  inboxBySource: Record<string, number>;
  /** MCP tool calls recorded today (in-memory — since app launch). */
  mcpCallsToday: number;
  mcpTopTool: string | null;
  /** 24 local-hour buckets: session+inbox files / MCP calls, for the sparkbar. */
  hourlyFiles: number[];
  hourlyMcp: number[];
}

/** Pre-translated inflow lines for the tray surfaces; the native menu shows
 *  only `summary`, the tray panel renders every row (label / sub / count)
 *  plus the sparkbar and its caption. */
export interface TrayInflowPayload {
  header: string;
  sessions: string;
  sessionsSub: string;
  sessionsCount: string;
  mcp: string;
  mcpSub: string;
  mcpCount: string;
  inbox: string;
  inboxSub: string;
  inboxCount: string;
  inboxView: string;
  sparkCaption: string;
  summary: string;
  hourlyFiles: number[];
  hourlyMcp: number[];
}

/** One pending map proposal in the tray payload: its vault-relative path (the
 *  approve/reject action carries it back) plus both lines pre-translated. */
export interface TrayProposalPayload {
  path: string;
  label: string;
  sub: string;
}

/** One popover stat card; `id` doubles as the tray_panel_action on click. */
export interface TrayCardPayload {
  id: string;
  label: string;
  value: string;
  sub: string;
  accent: boolean;
}

export interface TrayStatusPayload {
  /** Pre-formatted running rows, shown as disabled info items. */
  running: TrayRunningRow[];
  /** Section headers (disabled rows); empty string hides the header. */
  runningHeader: string;
  waitingHeader: string;
  /** Text next to the tray icon ("72%", "2"); null clears it. */
  title: string | null;
  suggested: string;
  /** Quarantined items awaiting review; "" when there are none. */
  quarantine?: string;
  /** Unseen reflect findings ("6 reflect suggestions"); "" hides the row. */
  reflect: string;
  mcp: string;
  /** Today's-inflow block; null/absent hides the section everywhere. */
  inflow?: TrayInflowPayload | null;
  /** Pending map proposals the panel can approve/reject inline (capped; the
   *  overflow becomes `proposalsMore`). Absent/empty hides the rows. */
  proposals?: TrayProposalPayload[];
  /** "+N more" row text; "" when nothing overflowed. */
  proposalsMore?: string;
  proposalApprove?: string;
  proposalReject?: string;
  /** builtin-local caveat shown under the rows; "" when a provider can draft. */
  proposalNote?: string;
  /** Header line under the mascot; absent on older payloads. */
  greeting?: string;
  /** Stat cards; absent/empty hides the grid. */
  cards?: TrayCardPayload[];
  ask: string;
  distill: string;
  open: string;
  quit: string;
}

export interface MycoProResult {
  summary: string;
  applied: number;
  paths: string[];
}

export interface MycoProLogin {
  email: string;
  /** True when the account has active access (a usable key was stored). */
  connected: boolean;
}

// --- In-app agent (Feature 4) ---

/** A tool the agent may call (mirrors Rust agent_tools::ToolDescriptor). */
export interface AgentToolDescriptor {
  name: string;
  description: string;
  input_schema: unknown;
  /** True for vault-mutating tools that require per-call user confirmation. */
  write: boolean;
}

/** One tool call the model wants executed. */
export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A provider-neutral agent transcript turn sent to `agent_chat`. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
}

export interface AgentChatRequest {
  provider_id: string;
  model: string;
  system?: string;
  messages: AgentMessage[];
  tools: AgentToolDescriptor[];
  max_tokens?: number;
}

/** The model's reply: final `text`, or `tool_calls` the loop must satisfy. */
export interface AgentTurn {
  text: string;
  tool_calls: AgentToolCall[];
  usage: { input_tokens: number; output_tokens: number } | null;
  stop: string;
}

// --- Recurring schedules (Feature 7) ---

export type ScheduleKind = "query" | "changed" | "stale" | "topic" | "distill";

export interface Schedule {
  id: string;
  title: string;
  kind: ScheduleKind;
  prompt: string;
  /** "daily" | "weekly[:dow]" | "monthly[:dom]" | "every:<n>h". */
  cadence: string;
  output_dir: string;
  provider: string;
  model: string;
  notify: boolean;
  /** Epoch seconds of the last successful run, or null if never run. */
  last_run: number | null;
  enabled: boolean;
}

export interface ChatRequest {
  provider_id: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  provider_id: string;
  model: string;
  content: string;
  usage: { input_tokens: number; output_tokens: number } | null;
}

export interface OllamaModelInfo {
  name: string;
  size: number;
}

export interface OllamaStatus {
  binary_installed: boolean;
  binary_path: string | null;
  version: string | null;
  daemon_running: boolean;
  endpoint: string;
  models: OllamaModelInfo[];
  error: string | null;
}

export const ipc = {
  openVault: (path: string) => invoke<VaultMeta>("open_vault", { path }),
  ensureDefaultVault: () => invoke<string>("ensure_default_vault"),
  /** Fill a picked-but-empty vault with the demo notes (first-run offer). */
  seedSampleVault: (vault: string) =>
    invoke<null>("seed_sample_vault", { vault }),
  listFiles: (root: string) => invoke<FileNode[]>("list_files", { root }),
  fileMtimes: (root: string) =>
    invoke<[string, number][]>("file_mtimes", { root }),
  /** Intent of a question, by embedding it against exemplars. `null` when the
   *  question is an ordinary content question (the common case). Only worth
   *  calling once content retrieval has come up empty — it costs a query
   *  embedding. See `intent.rs` for the exemplars and the measured floor. */
  classifyIntent: (query: string, provider: string, model: string) =>
    invoke<{ intent: string; similarity: number } | null>("classify_intent", {
      query,
      provider,
      model,
    }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  /** Raw bytes of a `raw/`-confined source file (PDF viewer, Feature 6). */
  readRawBytes: (relpath: string) =>
    invoke<ArrayBuffer>("read_raw_bytes", { relpath }),
  /** Save image bytes under `assets/`; resolves to the vault-relative path. */
  writeAsset: (name: string, bytes: Uint8Array) =>
    invoke<string>("write_asset", bytes, { headers: { "x-myco-name": name } }),
  readVaultContext: (root: string, maxBytes: number) =>
    invoke<string>("read_vault_context", { root, maxBytes }),
  writeFile: (path: string, content: string) =>
    invoke<null>("write_file", { path, content }),
  writeRunLog: (vaultPath: string, name: string, content: string) =>
    invoke<null>("write_run_log", { vaultPath, name, content }),
  scaffoldObsidianVault: (vaultPath: string) =>
    invoke<string>("scaffold_obsidian_vault", { vaultPath }),
  readExternalText: (path: string) =>
    invoke<string>("read_external_text", { path }),
  fetchYoutubeTranscript: (url: string) =>
    invoke<string>("fetch_youtube_transcript", { url }),
  /** Describe an image with a vision provider (Feature 2 image ingest). */
  describeImage: (
    provider: string,
    model: string,
    path: string,
    prompt: string,
  ) => invoke<string>("describe_image", { provider, model, path, prompt }),
  /** Transcribe an audio/video file via an installed whisper CLI (Feature 2). */
  transcribeMedia: (path: string) =>
    invoke<string>("transcribe_media", { path }),
  /** Whether a whisper-family CLI is on PATH (gates the media-ingest button). */
  whisperCheck: () => invoke<ClaudeStatus>("whisper_check"),
  /** Save a spotlight voice capture: whisper-transcribe the recorded audio
   *  into the open vault's `_inbox/voice-<date>.md`. Plain number[] because
   *  invoke args are JSON — a Uint8Array would not reach Rust as Vec<u8>.
   *  `related`: wiki stems the transcript echoes (best-effort, may be []). */
  saveVoiceCapture: (bytes: number[]) =>
    invoke<{ rel: string; related: string[] }>("save_voice_capture", { bytes }),
  buildLinkGraph: (root: string) =>
    invoke<Adjacency>("build_link_graph", { root }),
  /** Cheap hash of the vault's markdown (path+mtime+length per .md). Ask this
   *  before rebuilding the graph — it is ~26x cheaper because it only stats. */
  vaultRevision: (root: string) => invoke<number>("vault_revision", { root }),
  // Multiverse: every universe is a registered project UNION the vault-like
  // sibling folders beside the open vault (so side-by-side vaults show without a
  // registry). Entering one opens it as the vault (openVault), so the old
  // Phase-0 registry-switch commands (list_projects / build_link_graph_at /
  // set_active_project) are gone.
  listUniverses: () => invoke<ProjectInfo[]>("list_universes"),
  /** Read-only link graph of a known universe by its ROOT path. */
  buildUniverseGraph: (root: string) =>
    invoke<Adjacency>("build_universe_graph", { root }),
  searchVault: (query: string, limit?: number) =>
    invoke<SearchHit[]>("search_vault", { query, limit }),
  // Semantic layer (Feature 1): embedding index over wiki pages.
  reindexEmbeddings: (provider: string, model: string) =>
    invoke<number>("reindex_embeddings", { provider, model }),
  semanticSearch: (
    query: string,
    k: number,
    provider: string,
    model: string,
    /** Inclusive YYYY-MM-DD day window — restricts hits to the dated tiers. */
    range?: { start: string; end: string },
  ) =>
    invoke<ScoredChunk[]>("semantic_search", {
      query,
      k,
      provider,
      model,
      range,
    }),
  /** 2D semantic-map coordinates (PCA over page embeddings) for every indexed page. */
  semanticMap: () => invoke<SemanticPoint[]>("semantic_map", {}),
  /** Existing pages a new source likely relates to — retrieval grounding for ingest. */
  wikifyCandidates: (sourceText: string, k: number) =>
    invoke<CandidatePage[]>("wikify_candidates", { sourceText, k }),
  relatedPages: (page: string, k: number) =>
    invoke<VecHit[]>("related_pages", { page, k }),
  embeddingsStatus: () => invoke<EmbeddingsStatus>("embeddings_status", {}),
  semanticEdges: (k: number) => invoke<SemEdge[]>("semantic_edges", { k }),
  /** Embed arbitrary texts with the bundled local embedder (bge-m3) — used by
   *  the extractive session digest to rank candidate quotes offline. */
  embedLocalTexts: (texts: string[]) =>
    invoke<number[][]>("embed_local_texts", { texts }),
  createFile: (parent: string, name: string) =>
    invoke<string>("create_file", { parent, name }),
  createFolder: (parent: string, name: string) =>
    invoke<string>("create_folder", { parent, name }),
  deletePath: (path: string) => invoke<null>("delete_path", { path }),
  renamePath: (from: string, toName: string) =>
    invoke<string>("rename_path", { from, toName }),
  archiveInboxSource: (path: string) =>
    invoke<string>("archive_inbox_source", { path }),
  /** Every file waiting in `_inbox/`, any extension — flat, dotfiles and
   *  subdirectories (quarantine/, .archived/) skipped. */
  listInboxEntries: (vault: string) =>
    invoke<InboxEntry[]>("list_inbox_entries", { vault }),
  availableRawPath: (stem: string) =>
    invoke<string>("available_raw_path", { stem }),
  pickDirectory: async (): Promise<string | null> => {
    const selection = await open({ directory: true, multiple: false });
    return typeof selection === "string" ? selection : null;
  },
  pickTextFile: async (): Promise<string | null> => {
    const selection = await open({
      directory: false,
      multiple: false,
      filters: [
        {
          name: "Documents",
          extensions: [
            "md",
            "txt",
            "markdown",
            "html",
            "json",
            "yaml",
            "yml",
            "csv",
            "tsv",
            "pdf",
            "xlsx",
            "xls",
            "xlsm",
            "xlsb",
            "ods",
            "docx",
            "pptx",
            // Images (vision ingest) + audio/video (whisper) — Feature 2.
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "mp3",
            "m4a",
            "wav",
            "flac",
            "ogg",
            "aac",
            "mp4",
            "mov",
            "webm",
            "mkv",
          ],
        },
      ],
    });
    return typeof selection === "string" ? selection : null;
  },
  /** Pick a conversation export (ChatGPT .json, or a Claude Code / Codex
   *  .jsonl session). Returns a real filesystem path for the Rust importer. */
  pickImportFile: async (): Promise<string | null> => {
    const selection = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Conversation export", extensions: ["json", "jsonl"] }],
    });
    return typeof selection === "string" ? selection : null;
  },
  importConversations: (sourcePath: string) =>
    invoke<ImportOutcome>("import_conversations", { sourcePath }),
  /** Import every on-disk session for a CLI tool in one pass (dedup-safe). */
  importSessionSweep: (kind: "claude-code" | "codex") =>
    invoke<ImportOutcome>("import_session_sweep", { kind }),
  /** Re-import an explicit list of files (retry-failed). `dest` must match the
   *  run that produced the failures: "_inbox" books a paid ingest per file,
   *  "sessions" does not. The backend refuses anything else. */
  importPaths: (paths: string[], dest: "_inbox" | "sessions") =>
    invoke<ImportOutcome>("import_paths", { paths, dest }),
  gitLog: (vaultPath: string, limit?: number) =>
    invoke<GitCommit[]>("git_log", { vaultPath, limit }),
  claudeCheck: () => invoke<ClaudeStatus>("claude_check"),
  claudeRun: (prompt: string, cwd: string, model?: string, effort?: string) =>
    invoke<ClaudeResult>("claude_run", { prompt, cwd, model, effort }),
  claudeRunStream: (
    runId: string,
    prompt: string,
    cwd: string,
    model?: string,
    effort?: string,
  ) =>
    invoke<ClaudeResult>("claude_run_stream", {
      runId,
      prompt,
      cwd,
      model,
      effort,
    }),
  claudeCancel: (runId: string) => invoke<boolean>("claude_cancel", { runId }),
  agentCheck: (provider: string) =>
    invoke<ClaudeStatus>("agent_check", { provider }),
  agentRun: (
    provider: string,
    model: string,
    prompt: string,
    cwd: string,
    effort?: string,
  ) =>
    invoke<ClaudeResult>("agent_run", { provider, model, prompt, cwd, effort }),
  scanTasks: (vaultPath: string) =>
    invoke<TaskItem[]>("scan_tasks", { vaultPath }),
  scanProvenance: (vaultPath: string) =>
    invoke<ProvenanceRow[]>("scan_provenance", { vaultPath }),
  /** Deterministic ingest gate (Phase 1f): dangling citations / missing
   *  required frontmatter / invalid enums are errors; unresolved wikilinks /
   *  source_count mismatch / missing superseded_by are warnings. */
  validateIngest: (vaultPath: string, changedPages: string[]) =>
    invoke<ValidationReport>("validate_ingest", { vaultPath, changedPages }),
  /** Deterministic wiki lint (no model): the validator's findings plus
   *  freshness / weak-confidence / hedged-claim checks. `pages` are
   *  vault-relative and already filtered to knowledge pages by the caller. */
  lintLocal: (vaultPath: string, pages: string[]) =>
    invoke<LintReport>("lint_local", { vaultPath, pages }),
  mycoProIngest: (slug: string, title: string, text: string) =>
    invoke<MycoProResult>("myco_pro_ingest", { slug, title, text }),
  mycoProLogin: (email: string, password: string) =>
    invoke<MycoProLogin>("myco_pro_login", { email, password }),
  mycoProLogout: () => invoke<null>("myco_pro_logout"),
  setProviderKey: (providerId: string, key: string) =>
    invoke<null>("set_provider_key", { providerId, key }),
  deleteProviderKey: (providerId: string) =>
    invoke<null>("delete_provider_key", { providerId }),
  getSettings: () => invoke<MycoSettings>("get_settings"),
  /** Refresh the macOS menu bar tray (menu rows + icon-side title). */
  updateTrayStatus: (status: TrayStatusPayload) =>
    invoke<null>("update_tray_status", { status }),
  /** Last pushed tray snapshot — the tray popover window's data source. */
  getTrayStatus: () => invoke<TrayStatusPayload>("get_tray_status"),
  /** Tray popover quick action; same Rust routing as the native menu rows.
   *  "query" | "distill" | "open" | "quit" | "overview" | "settings" |
   *  "dismiss" (hide the panel only). */
  trayPanelAction: (action: string) =>
    invoke<null>("tray_panel_action", { action }),
  /** Fit the tray popover window to the card's measured height (logical px). */
  resizeTrayPanel: (height: number) =>
    invoke<null>("resize_tray_panel", { height }),
  /** Is the global ask shortcut actually registered right now? */
  spotlightStatus: () => invoke<SpotlightStatus>("spotlight_status"),
  /** Change the global ask shortcut (empty string disables it). Persists and
   *  re-registers in one step; the returned status says what really happened. */
  setSpotlightShortcut: (shortcut: string) =>
    invoke<SpotlightStatus>("set_spotlight_shortcut", { shortcut }),
  /** Hide the spotlight window (its own webview is not allowed to). */
  closeSpotlight: () => invoke<null>("close_spotlight"),
  /** Fit the spotlight window to its measured card height (logical px). */
  resizeSpotlight: (height: number) =>
    invoke<null>("resize_spotlight", { height }),
  /** Notch geometry of the built-in display, read from NSScreen. */
  notchGeometry: () => invoke<NotchGeometry>("notch_geometry"),
  /** COPY a dropped file into the open vault's `_inbox/<destName>` — the notch
   *  drop path. Vault-confined on the Rust side (VaultRoot), so the calling
   *  webview never needs the vault path. Returns what was written. */
  copyIntoInbox: (srcAbs: string, destName: string) =>
    invoke<string>("copy_into_inbox", { srcAbs, destName }),
  /** WRITE a composed note (pasted link/selection on the notch) into the open
   *  vault's `_inbox/<destName>` — copy_into_inbox's sibling for content with
   *  no file behind it. Same confinement; returns what was written. */
  writeInboxNote: (destName: string, content: string) =>
    invoke<string>("write_inbox_note", { destName, content }),
  /** Session backfill (spec 2026-08-28): how much of the `sessions/` archive
   *  is still un-wikified, and what the size buckets hold. */
  backfillStatus: () => invoke<BackfillStatus>("backfill_status"),
  /** Copy the next `limit` eligible sessions into `_inbox/`; the normal
   *  auto-ingest pass turns them into wiki pages from there. */
  promoteSessions: (limit: number) =>
    invoke<BackfillPromotion>("promote_sessions", { limit }),
  /** Fit the notch window to the surface (logical px) — resize_tray_panel's
   *  pattern, plus width: the panel unfolds from the cap to a 300px body. */
  notchResize: (width: number, height: number) =>
    invoke<null>("notch_resize", { width, height }),
  /** Notch S7: append `- HH:MM <text>` to today's daily note (seeded with its
   *  date heading on first use — PageTasks' addTask convention). The offset
   *  ships the webview's LOCAL clock: daily notes bucket on the user's
   *  calendar day (taskLine.today), and Rust alone only knows UTC. Returns
   *  the vault-relative path written. */
  captureNote: (text: string) =>
    invoke<string>("capture_note", {
      text,
      tzOffsetMin: -new Date().getTimezoneOffset(),
    }),
  /** Ask the notch NSPanel to take key focus so the S7 input can type.
   *  Resolves whether it really became the key window — a nonactivating
   *  panel may refuse; the caller logs the answer either way. */
  notchFocusCapture: () => invoke<boolean>("notch_focus_capture"),
  /** Apply the notch toggle live (show/hide the window). Persisting the flag
   *  itself goes through set_settings like every other setting. */
  updateNotchEnabled: (enabled: boolean) =>
    invoke<null>("update_notch_enabled", { enabled }),
  setSettings: (value: MycoSettings) => invoke<null>("set_settings", { value }),
  /** Write the settings/looks export bundle to a path the user chose via the
   *  native save dialog. */
  writeSettingsExport: (path: string, contents: string) =>
    invoke<null>("write_settings_export", { path, contents }),
  /** Read a settings/looks export file chosen via the native open dialog. */
  readSettingsImport: (path: string) =>
    invoke<string>("read_settings_import", { path }),
  /** Where to write a settings/looks export — native save dialog, or null if
   *  the user cancelled. */
  pickSettingsExportPath: async (): Promise<string | null> => {
    const path = await save({
      defaultPath: "myco-settings.json",
      filters: [{ name: "myco settings", extensions: ["json"] }],
    });
    return path ?? null;
  },
  /** Which settings/looks export file to import — native open dialog, or
   *  null if the user cancelled. */
  pickSettingsImportPath: async (): Promise<string | null> => {
    const selection = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "myco settings", extensions: ["json"] }],
    });
    return typeof selection === "string" ? selection : null;
  },
  chatComplete: (request: ChatRequest) =>
    invoke<ChatResponse>("chat_complete", { request }),
  // In-app agent (Feature 4).
  agentToolsSchema: () =>
    invoke<AgentToolDescriptor[]>("agent_tools_schema", {}),
  agentToolCall: (
    name: string,
    args: Record<string, unknown>,
    allowWrite: boolean,
  ) => invoke<unknown>("agent_tool_call", { name, args, allowWrite }),
  agentChat: (request: AgentChatRequest) =>
    invoke<AgentTurn>("agent_chat", { request }),
  // Recurring schedules (Feature 7).
  listSchedules: (vault: string) =>
    invoke<Schedule[]>("list_schedules", { vault }),
  upsertSchedule: (vault: string, schedule: Schedule) =>
    invoke<Schedule[]>("upsert_schedule", { vault, schedule }),
  deleteSchedule: (vault: string, id: string) =>
    invoke<Schedule[]>("delete_schedule", { vault, id }),
  /** Install/remove a launchd LaunchAgent for app-closed digest runs (macOS). */
  installBackgroundSchedule: (vault: string, id: string, on: boolean) =>
    invoke<string>("install_background_schedule", { vault, id, on }),
  // Distillation config (Task 2, Phase A).
  getDistillConfig: (vault: string) =>
    invoke<DistillConfig>("get_distill_config", { vault }),
  setDistillConfig: (vault: string, config: DistillConfig) =>
    invoke<null>("set_distill_config", { vault, config }),
  // Idle-run orchestrator: archive, trash, manifest, undo (Task 6, Phase A).
  distillRun: (vault: string) => invoke<RunReport>("distill_run", { vault }),
  undoDistillRun: (vault: string, id: string) =>
    invoke<number>("undo_distill_run", { vault, id }),
  // Run list with per-row undo (Q4 item 3).
  listDistillRuns: (vault: string, limit?: number) =>
    invoke<RunSummary[]>("list_distill_runs", { vault, limit }),
  // Run drill-in: full manifest + WHY report + git commit (W3–6 item 6).
  distillRunDetail: (vault: string, id: string) =>
    invoke<RunDetail>("distill_run_detail", { vault, id }),
  /** Per-file before/after for a run's commit; rejects "no-commit" when the
   *  run has none — callers fall back to the manifest file list. */
  distillRunDiff: (vault: string, id: string) =>
    invoke<FileDiff[]>("distill_run_diff", { vault, id }),
  // Opt-in vault git history (Q4 item 1).
  vaultHistoryStatus: (vault: string) =>
    invoke<VaultHistoryStatus>("vault_history_status", { vault }),
  initVaultHistory: (vault: string) =>
    invoke<null>("init_vault_history", { vault }),
  commitHumanEdit: (vault: string, rel: string) =>
    invoke<boolean>("commit_human_edit", { vault, rel }),
  // Authorship badge + human-only filter (Q4 item 16).
  /** Line ownership of one page; null = no history, no claim. */
  pageAuthorship: (vault: string, rel: string) =>
    invoke<PageAuthorship | null>("page_authorship", { vault, rel }),
  /** wiki/ rel -> ever committed by the agent author. */
  authorshipIndex: (vault: string) =>
    invoke<AuthorshipIndex>("authorship_index", { vault }),
  // Morning-Report suspect scan (Q4 item 2).
  suspectPages: (vault: string) =>
    invoke<SuspectReport>("suspect_pages", { vault }),
  // Recall miss log (Q4 item 5).
  recordRecallMiss: (vault: string, query: string, expected?: string) =>
    invoke<null>("record_recall_miss", { vault, query, expected }),
  // Page-open tracking (Q4 item 10) — feeds resurface dormancy.
  recordPageOpen: (vault: string, rel: string) =>
    invoke<null>("record_page_open", { vault, rel }),
  /** Redaction scan (Q4 item 13) — call before any raw/ write. */
  scanTextSecrets: (text: string) =>
    invoke<SecretScanReport>("scan_text_secrets", { text }),
  /** Read-only raw/ + git-history audit (Q4 item 14) — never modifies raw/. */
  scanRawAudit: (vault: string) =>
    invoke<RawAuditReport>("scan_raw_audit", { vault }),
  /** Dormant wiki pages echoing `seedText` — resurface (Q4 item 10). */
  resurfaceCandidates: (
    vault: string,
    seedText: string,
    k: number,
    floor: number,
  ) =>
    invoke<ResurfaceCandidate[]>("resurface_candidates", {
      vault,
      seedText,
      k,
      floor,
    }),
  distillStatus: (vault: string) =>
    invoke<DistillStatus>("distill_status", { vault }),
  // ROADMAP P2 — archive lifecycle. `archiveUsage` is on-demand only (called
  // from the Distill tab's storage panel when it mounts / after an action,
  // never per render); `compressArchives` is only ever reached from its
  // button. Both are confined to sessions/daily archives — raw/ is immutable
  // and is not even nameable through `tree` (see archive_pack.rs).
  archiveUsage: (vault: string) =>
    invoke<BucketUsage[]>("archive_usage", { vault }),
  compressArchives: (vault: string, olderThanMonths: number) =>
    invoke<PackReport>("compress_archives", { vault, olderThanMonths }),
  restoreArchiveBucket: (vault: string, tree: ArchiveTree, bucket: string) =>
    invoke<RestoreReport>("restore_archive_bucket", { vault, tree, bucket }),
  // Execute a pending distill proposal (Task 7, Phase A).
  applyDistillProposal: (vault: string, path: string) =>
    invoke<string>("apply_distill_proposal", { vault, path }),
  // Quarantine review (ROADMAP P0): list what the gate held back, and the two
  // resolutions that need Rust — restore goes through the same re-admit path
  // an approved admit-cluster proposal takes, keep-longer bumps the sidecar
  // TTL. Delete is `deletePath` (OS trash), not a command of its own.
  listQuarantine: (vault: string) =>
    invoke<QuarantineItem[]>("list_quarantine", { vault }),
  restoreQuarantine: (vault: string, files: string[]) =>
    invoke<string>("restore_quarantine", { vault, files }),
  extendQuarantine: (vault: string, files: string[], days: number) =>
    invoke<number>("extend_quarantine", { vault, files, days }),
  // Session-digest bookkeeping (Phase B, Task 1).
  digestableSessionDays: (vault: string) =>
    invoke<DigestDay[]>("digestable_session_days", { vault }),
  // `fingerprints` (parallel to `files`) is the content this caller actually
  // digested: Rust re-checks each file against it just before the rename and
  // leaves a file that changed since then in `sessions/`. `null` on the
  // archive-retry path, whose digest came from an earlier run — Rust falls
  // back to the on-disk digest markers there.
  archiveDigestedSessions: (
    vault: string,
    day: string,
    files: string[],
    fingerprints: string[] | null,
  ) =>
    invoke<string>("archive_digested_sessions", {
      vault,
      day,
      files,
      fingerprints,
    }),
  // Rollup bookkeeping — the same pair one (`"weekly"`, ROADMAP P1) or two
  // (`"monthly"`) compression layers up: settled buckets whose source files
  // are ready to roll up, and the cold-tier move for a bucket that has been
  // rolled up. `fingerprints` carries the same meaning as above (null =
  // archive-retry path).
  rollupableBuckets: (vault: string, layer: "weekly" | "monthly") =>
    invoke<RollupBucket[]>("rollupable_buckets", { vault, layer }),
  archiveRolled: (
    vault: string,
    layer: "weekly" | "monthly",
    bucket: string,
    files: string[],
    fingerprints: string[] | null,
  ) =>
    invoke<string>("archive_rolled", {
      vault,
      layer,
      bucket,
      files,
      fingerprints,
    }),
  // Gate-admitted Full-tier items ready for LLM ingest (Phase B, Task 3).
  fullTierItems: (vault: string) =>
    invoke<string[]>("full_tier_items", { vault }),
  // Records a TS-side LLM step's file moves/creates into the same
  // .myco/distill-runs/<id>.json undo-manifest Rust's own passes already
  // write incrementally (Important 4, Phase B whole-branch review) —
  // session digest's daily-file create, full-tier ingest's inbox-archive +
  // raw-create, draft-map's file write.
  appendDistillManifest: (
    vault: string,
    id: string,
    moves: { from: string; to: string }[],
    created: string[],
  ) => invoke<null>("append_distill_manifest", { vault, id, moves, created }),
  listProviderModels: (providerId: string) =>
    invoke<string[]>("list_provider_models", { providerId }),
  ollamaStatus: () => invoke<OllamaStatus>("ollama_status"),
  ollamaInstallUrl: () => invoke<string>("ollama_install_url"),
  openExternal: (url: string) => invoke<null>("open_external", { url }),
  mcpInfo: () => invoke<McpNativeInfo>("mcp_info"),
  /** Today's inflow (sessions/inbox/MCP + hourly buckets). "Today" follows
   *  the caller's clock — the tz offset crosses with the request. */
  inflowStats: (root: string) =>
    invoke<InflowStats>("inflow_stats", {
      root,
      tzOffsetMin: new Date().getTimezoneOffset(),
    }),
  /** Daily inflow by channel from the persistent ledger
   *  (.myco/inflow-log.jsonl) — the overview board's volume charts. Days are
   *  the caller's local days, zero-filled, oldest first. */
  inflowDaily: (days: number) =>
    invoke<InflowDay[]>("inflow_daily", {
      days,
      tzOffsetMin: new Date().getTimezoneOffset(),
    }),
  /** Write one board doc (creates .myco/dashboards/ on first save). */
  saveDashboard: (name: string, content: string) =>
    invoke<void>("save_dashboard", { name, content }),
  /** Saved board names (file stems) — the file listing IS the list. */
  listDashboards: () => invoke<string[]>("list_dashboards"),
  deleteDashboard: (name: string) =>
    invoke<void>("delete_dashboard", { name }),
  /** Saved Views (`.myco/views/<name>.json`) — same name rules as boards. */
  saveView: (name: string, content: string) =>
    invoke<void>("save_view", { name, content }),
  listViews: () => invoke<string[]>("list_views"),
  deleteView: (name: string) => invoke<void>("delete_view", { name }),
  mcpConnect: () => invoke<string>("mcp_connect"),
  // Embedded local model (bundled Gemma 3 1B) — offline, no key. First call
  // lazily loads the weights, so it can take a few extra seconds.
  localQuery: (prompt: string, maxTokens?: number) =>
    invoke<string>("local_query", { prompt, maxTokens }),
  // Cheap `is_file()` check (no model load) — no chat GGUF has shipped since
  // Ask went extractive, so this is normally always false.
  localChatModelAvailable: () => invoke<boolean>("local_chat_model_available"),
  // ROADMAP P2 — crash report viewer (Settings -> About).
  recentPanics: (limit: number) =>
    invoke<PanicEntry[]>("recent_panics", { limit }),
  clearPanicLog: () => invoke<null>("clear_panic_log"),
  osVersion: () => invoke<string>("os_version"),
};
