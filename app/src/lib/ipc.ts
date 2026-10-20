// Type-safe wrappers around Tauri invoke calls. Keep this file thin: it must
// reflect the Rust command signatures in src-tauri/src/commands.rs.

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { IMAGE_EXTS } from "./assets";
import { queryDateRange } from "./timeQuery";
import type { RoleSnapshot, RoleId, RoleUsage, RoleSelectionRequest, ModelRoleSettings } from "./modelRoles";
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
import type { Captured } from "./dailyNote";
import type { QuarantineItem } from "./quarantine";
import type { VaultActionScope } from "./notchAction";

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

/** One `.myco/plugins/<dir>/manifest.json` as list_plugins read it
 *  (src-tauri/src/plugins.rs); `raw` is null when `error` says why. */
export interface PluginFile {
  dir: string;
  raw: string | null;
  error: "missing" | "outside" | "too_large" | "unreadable" | null;
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

/** Exact editor bytes and revision read under one native vault opening. */
export interface EditorFileSnapshot {
  file: FileContent;
  origin: AgentVaultSession;
  revision: string;
  /** Browser demo receipts are synthetic and never establish native authority. */
  mockOnly?: true;
}

/** The actual persisted revision of an origin-bound conditional editor save. */
export interface EditorWriteReceipt {
  path: string;
  origin: AgentVaultSession;
  revision: string;
  mockOnly?: true;
}

/** Durable recovery data; its original opening is provenance, not write authority. */
export interface RecoveryDraft {
  path: string;
  baselineRaw: string;
  baselineRevision: string;
  draftRaw: string;
  /** Native-issued journal nonce, distinct from a file-content SHA. */
  revision: string;
  origin: AgentVaultSession;
  mockOnly?: true;
}

/** Public identity of one private native-held deck baseline. */
export interface StudyDeckContext {
  readonly snapshotId: string;
  readonly origin: AgentVaultSession;
  readonly path: string;
}

/** Null revision means actual absence, never an unreadable or empty file. */
export interface StudyDeckSnapshot {
  context: StudyDeckContext;
  raw: string;
  revision: string | null;
  mockOnly?: true;
}

/** A partial write is retained on disk and must not be retried automatically. */
export interface StudyDeckWriteReceipt {
  path: string;
  origin: AgentVaultSession;
  state: "persisted" | "partial";
  revision: string | null;
  error: string | null;
  mockOnly?: true;
}

/** Per-node wiki frontmatter the graph encodes visually (from index.rs). */
export interface NodeMeta {
  type?: string;
  confidence?: string;
  status?: string;
  sourceCount?: number;
  /** Frontmatter `title` — names an opaque session stem (lib/displayName). */
  title?: string;
}

export interface Adjacency {
  forward: Record<string, string[]>;
  backward: Record<string, string[]>;
  unresolved: Record<string, string[]>;
  tags: Record<string, string[]>;
  /** Keyed by the same absolute path as `forward`. Absent for older backends. */
  meta?: Record<string, NodeMeta>;
  /**
   * Hash of the whole graph. Equal revs mean an identical graph, so a poller
   * can skip re-rendering. Absent for older backends.
   */
  rev?: number;
  /** Notes the build could not read — not downloaded yet (iCloud) or
   *  unreadable. Absolute paths. Absent for older backends. */
  unread?: string[];
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
  /** Installation alone does not grant optional external execution. */
  execution?: {
    readOnly: boolean;
    stagedWrite: boolean;
    reason: string;
  };
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
  /** Verified phrase/identifier or substantive exact query coverage from the
   * current source text. A BM25 hit alone does not set this. */
  exact_match?: boolean;
  /** Ranking-explain fields (tier priors). Optional so a backend that predates
   *  them degrades to "prior 1, final = score, no rank change" — the same rule
   *  `similarity` follows. `score_rrf` is the pure fusion score before the
   *  prior; `score_final = score_rrf × prior` is the order hits arrive in;
   *  `rank_change` is positions moved vs. the pure-RRF order, positive = up. */
  tier?: HitTier;
  prior?: number;
  score_rrf?: number;
  score_final?: number;
  rank_change?: number;
}

/** Where Ask searches. `wiki` is the knowledge layers only; `sessions` is the
 *  session corpus (plus `sessions/archive/` when `search_archived_sessions`
 *  is on); `all` is both. */
export type AskScope = "wiki" | "sessions" | "all";
/** What semantic_search takes: an Ask scope, or `pages` — wiki/ notes and
 *  maps only, a code plugin's recall. */
export type SearchScope = AskScope | "pages";

/** Ranking tier the backend assigns a hit — the folder layers
 *  `extractive.ts::sourceTier` names, with `monthly` folded into `rollup`. */
export type HitTier = "note" | "map" | "digest" | "rollup" | "session" | "source";

/** Per-tier multiplier on a hit's RRF score (`final = rrf × prior`). */
export type TierWeights = Record<HitTier, number>;

/** A hit that fell under the relevance floor — the abstention card's near-miss
 *  rows. `similarity` is the dense cosine when the backend carries it (`null`
 *  = lexical-only, no cosine) and absent when it sends the bare triple. */
/** One finished Ask turn as the page showed it, from this device's
 *  per-vault history log (UX S36). Mirrors `ask_history::AskTurn`. */
export interface AskRecord {
  /** Unix ms the turn finished. */
  at: number;
  q: string;
  scope?: AskScope;
  /** The answer as shown: the quoted lines under their [[stem]] (extractive)
   *  or the provider's text. Empty for an abstained, failed or stopped turn. */
  a: string;
  /** Stems of the notes the answer cited. */
  cited: string[];
  abstained?: boolean;
  stopped?: boolean;
  error?: string;
  /** "Ask this note" (UX S37): the turn ran over this note and its one-hop
   *  links instead of a scope. */
  note?: { title: string };
}

export interface NearMiss {
  page: string;
  tier: HitTier;
  score_final: number;
  similarity?: number | null;
}

/** What `semantic_search` returns: the hits that cleared the dense-cosine
 *  relevance `floor`, plus up to four that did not. */
export interface SemanticSearchResult {
  hits: ScoredChunk[];
  floor: number;
  below_floor: NearMiss[];
}

/** Original dated transcript excerpts, without a semantic relevance score. */
export interface TemporalEvent {
  page: string;
  stem: string;
  title?: string | null;
  section: number;
  text: string;
  role: string;
  timestamp: number;
}

/** A bounded read of indexed records; incomplete never proves absence. */
export interface TemporalRecallResult {
  events: TemporalEvent[];
  indexed_pages: number;
  scanned_pages: number;
  matched_events: number;
  incomplete: boolean;
}

/** Complete indexed passages selected by recorded dates, without cosine scores. */
export type ActivitySource = Pick<ScoredChunk, "page" | "stem" | "section" | "text"> & {
  /** Bounded project label read from the current native source, not a work claim. */
  title?: string;
};
export interface ActivityRecallResult {
  hits: ActivitySource[];
  indexed_pages: number;
  scanned_pages: number;
  matched_chunks: number;
  incomplete: boolean;
}

export interface LocalQueryPlanRequest {
  requestId: string;
  origin: AgentVaultSession;
  roleSnapshot?: RoleSnapshot;
  modelId: string;
  expectedVault: string;
  question: string;
  today: string;
  scope: AskScope;
  paths?: string[];
}

export interface LocalQueryPlan {
  start: string;
  end: string;
  model_id: string;
}

/** Availability is checked without running a local chat inference. */
export interface LocalChatStatus {
  model_id: string;
  state: "missing" | "ready" | "error";
  bytes: number;
  reason?: string;
}

/** Progress belongs to an explicit local chat-model download. */
export interface LocalChatModelProgress {
  downloaded: number;
  total: number;
  pct: number;
}

/** Only already retrieved passages may enter local Ask synthesis. */
export interface LocalSynthesisRequest {
  modelId?: string;
  origin?: AgentVaultSession;
  roleSnapshot?: RoleSnapshot;
  requestId: string;
  expectedVault: string;
  question: string;
  /** A follow-up's question-only topic; previous generated prose is excluded. */
  previousQuestion?: string;
  lang: "en" | "ko" | "ja";
  scope: AskScope;
  range?: { start: string; end: string };
  paths?: string[];
  hits: Pick<ScoredChunk, "page" | "stem" | "section" | "text">[];
  maxTokens?: number;
  activityOverview?: boolean;
  resolution?: ActivityResolutionRequest;
}

/** Bounded local preview; the model never receives filesystem write tools. */
export interface LocalTransformRequest {
  origin?: AgentVaultSession;
  roleSnapshot?: RoleSnapshot;
  requestId: string;
  expectedVault: string;
  kind: "ingest" | "organize";
  lang: "ko" | "en" | "ja";
  modelId?: string;
  sources: { page: string; revision: string; text: string }[];
  sessionCompile?: SessionCompileContext;
}

/** Native-issued session attempts retain compiler identity across queue writes. */
export interface SessionSourceBinding { key: string; rawPath: string; sourceRevision: string }
export interface SessionCompileContext {
  jobId: string;
  attemptId: string;
  origin: AgentVaultSession;
  roleSnapshot: RoleSnapshot;
  source: SessionSourceBinding;
  compileSignature: string;
  summaryPath: string;
  indexPath: string;
  logPath: string;
  reportPath: string;
}
export interface SessionQueueItem extends SessionSourceBinding {
  title: string;
  srcSlug: string;
  summaryPath: string | null;
  compileJobId?: string | null;
  compilationState?: "pending" | "running" | "partial" | "stopped" | "failed" | "completed" | "superseded";
  compilationReason?: string | null;
}
export interface SessionCompileOutcome {
  ok: boolean;
  state: "partial" | "completed";
  attemptId: string;
  reason?: string;
}
/** Native checkpoint telemetry is distinct from held-out semantic acceptance. */
export interface SessionCompileStepReceipt {
  packetIndex: number;
  processedWindows: number;
  eligibleWindows: number;
  omittedWindows: number;
  reviewAccepted: boolean;
  nativeReviewRevision: string;
  sourceSchemaChecked: boolean;
  allPacketsSeen: boolean;
}
export interface SessionCompileStepResult {
  attemptId: string;
  sourceRevision: string;
  state: "running" | "completed" | "partial";
  step: SessionCompileStepReceipt | null;
  nextPacket: number;
  eligibleWindows: number;
  publication: SessionCompileOutcome | null;
}

/** A saved failure outcome is issued by the native owner of this exact request. */
export interface SessionCompileFailure {
  version: "SessionCompileFailureV1";
  message: string;
  outcome: {
    attemptId: string;
    sourceRevision: string;
    compileSignature: string;
    origin: AgentVaultSession;
    roleSnapshotId: string;
    /** Null is private native execution only and is not admitted by this UI. */
    requestId: string | null;
    state: "pending" | "partial" | "failed" | "stopped";
    reason: "model_preparation_unavailable" | "custody_retirement_pending" | "semantic_review_unavailable" | "model_host_failed" | "processing_failed" | "task_failed" | "cancelled";
  } | null;
  finalizationError: string | null;
}

/** App-computed structural coverage, distinct from semantic answer review. */
export interface ActivityResolutionRequest {
  mode: "historical_as_of" | "current_state";
  asOfEpoch: number;
  capturedQueryEpoch: number;
}

export interface ActivityResolutionCoverage {
  candidateChunks: number;
  scannedPages: number;
  admittedPages: number;
  originalSpans: number;
  processedWindows: number;
  omittedWindows: number;
  excludedAfterAsOfSpans: number;
  undatedSpans: number;
  readBytes: number;
  incomplete: boolean;
  issues: { citationPage: string; code: string }[];
}

/** Native-bound originals are citation authority, not independent semantic review. */
export interface ActivityAdditionalSource {
  citationPage: string;
  citationRevision: string;
  title: string | null;
  stem: string;
  origin: AgentVaultSession;
  scope: AskScope;
  lineage: {
    sourcePath: string;
    sourceRevision: string;
    spans: {
      id: string;
      start: number;
      end: number;
      sha256: string;
      speaker: "user" | "assistant" | "tool" | "system" | "source" | "unknown";
      turnTime: string | null;
      recordTime: string | null;
      sourcePhase: string | null;
    }[];
  }[];
}

/** Native record-time span counts; these are not event or activity counts. */
export interface ActivityPeriodSpanCounts {
  inPeriodSpans: number;
  outsidePeriodSpans: number;
  uncertainSpans: number;
}

export interface ActivitySynthesisReceipt {
  activityPeriod: { start: string; end: string; startEpoch: number | null; endEpoch: number | null };
  scope: AskScope;
  eligibleOriginalSpans: number;
  originalPeriodCounts: ActivityPeriodSpanCounts;
  boundedWindows: number;
  processedWindows: number;
  omittedWindows: number;
  extractionBatches: number;
  proposedClaims: number;
  selectedClaims: number;
  omittedClaims: number;
  answerOriginalSpans: number;
  answerPeriodCounts: ActivityPeriodSpanCounts;
  claimSourceAndStructureChecked: boolean;
  semanticReviewRequired: boolean;
  /** Separate automated passes; neither this count nor a SHA proves meaning. */
  automatedClaimReviews: number;
  automatedAnswerReviewInputRevision: string;
  originalInputsIncomplete: boolean;
  independentVerificationReceipts: number;
  resolutionWindow: (ActivityResolutionRequest & { startEpoch: number; endEpoch: number }) | null;
  resolutionCoverage?: ActivityResolutionCoverage | null;
  additionalSources?: ActivityAdditionalSource[];
}

/** Source and citation checks do not establish semantic correctness. */
export interface LocalSynthesisResult {
  answer: string;
  model_id: string;
  used_sources: string[];
  selected_chunks?: number;
  fallback_reason?: string;
  /** Native ordinary-answer protocol fields; these do not confer semantic authority. */
  answerReceipt?: { answerOriginalSpans: number; automatedAnswerReviewInputRevision: string };
  activity_receipt?: ActivitySynthesisReceipt;
  activity_failure?: { code: string; detail: string };
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
  origin?: AgentVaultSession;
  requestId?: string;
}

/** A semantic-similarity edge for the graph overlay (absolute page paths). */
export interface SemEdge {
  source: string;
  target: string;
  score: number;
}

/** Completeness of a native session inventory read. */
export type SessionReadStatus = "complete" | "partial" | "read_failed";
/** Read diagnostics use paths relative to the active vault. */
export interface SessionReadIssue {
  path: string;
  code: "state_read" | "state_decode" | "directory_read" | "entry_read" | "metadata_read" | "body_read" | "completion_read";
  message: string;
}

/** Counts behind the Ingest page's session-backfill card. */
export interface BackfillStatus {
  read_status: SessionReadStatus;
  read_issues: SessionReadIssue[];
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
  model_roles?: ModelRoleSettings;
  role_authorization_revision?: string;
  /** Absent in legacy payloads; false keeps recoverable deletion. */
  permanent_delete?: boolean;
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
  /** Ask's session scope also searches `sessions/archive/` (the cold tier
   *  `is_cold()` keeps out of the index). Turning it on re-indexes. */
  search_archived_sessions: boolean;
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

/** Mirrors Rust `web_fetch::WebPage` (S38); `url` is after redirects. */
export interface WebPage {
  url: string;
  title: string;
  markdown: string;
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

/** Mirrors Rust `vault_history::LineRun` — one maximal run of consecutive
 *  lines from a single commit, 1-based and inclusive at both ends. Built from
 *  the same `git blame --line-porcelain` the counts come from (no extra git
 *  call); the reader's authorship gutter maps these onto paragraphs. */
export interface LineRun {
  from: number;
  to: number;
  agent: boolean;
  sha: string;
  /** Author time, unix secs. */
  ts: number;
}

/** Mirrors Rust `vault_history::PageAuthorship` (Q4 item 16). */
export interface PageAuthorship {
  agent_lines: number;
  human_lines: number;
  last_human_at: number | null;
  runs: LineRun[];
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
  deleted?: number;
  created: number;
}

/** Mirrors Rust `distill::RunDetail` (W3–6 item 6). */
export interface RunDetail {
  id: string;
  started_at: number;
  moves: [string, string][];
  trashed: [string, string][];
  deleted?: string[];
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

/** Where myco roams (mirrors Rust `roam::RoamPlace`), in the roam window's
 *  own points: x right and y down from its top-left, which sits just under the
 *  menu bar. `notch_left` is the collapsed notch surface's left edge (the
 *  hardware cutout's, or the notchless target's), where myco enters and exits. */
export interface RoamPlace {
  width: number;
  height: number;
  notch_left: number;
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
/** One running activity row; `kind` picks the native menu row icon (Rust
 *  draws none for a kind it does not know) and the clip myco plays while it
 *  roams (lib/roamTrigger). */
export interface TrayRunningRow {
  kind: "ask" | "distill" | "reflect" | "index" | "ingest" | "links";
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
  /** Sessions promoted out of the harvest queue. */
  harvest: number;
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

/** The tray panel's glass tiles (tray v3): raw counts (the badges animate
 *  on growth, so they cannot arrive pre-formatted) plus their labels. Rust
 *  stores this block as opaque JSON — it owns no tile logic. */
/** One waiting decision the notch can settle without opening the app. Fully
 *  pre-translated and pre-routed like the rest of the tray payload: the notch
 *  renders the strings and emits the action string back on TRAY_ACTION_EVENT,
 *  where the main window (the single writer) acts on it. */
export interface NotchAgendaRow {
  /** Stable row identity — a proposal path, a suggestion pair key, or
   *  "harvest". What "this row left the list" is keyed on. */
  id: string;
  label: string;
  sub: string;
  primaryLabel: string;
  primaryAction: string;
  /** Both empty for a queue row: harvesting is not a yes/no decision. */
  secondaryLabel: string;
  secondaryAction: string;
}

/** The notch's agenda. `total` counts every waiting decision; `rows` is the
 *  capped, actionable head of it (lib/notchAgenda). */
export interface NotchAgendaPayload {
  total: number;
  rows: NotchAgendaRow[];
}

export interface TrayPanelPayload {
  /** The exact vault-open session that produced these actionable rows. */
  actionScope?: VaultActionScope | null;
  mcpRunning: boolean;
  /** What the notch shows and can act on. Absent on older payloads — the
   *  notch then draws nothing when collapsed, as it did before it had one. */
  agenda?: NotchAgendaPayload | null;
  counts: {
    links: number;
    reflect: number;
    overdue: number;
    dueToday: number;
    /** Session sweeps + _inbox arrivals today. */
    files: number;
    mcpCalls: number;
  };
  labels: {
    waiting: string;
    today: string;
    links: string;
    reflect: string;
    tasks: string;
    tasksDue: string;
    tasksOverdue: string;
    sessions: string;
    mcpCalls: string;
    last24: string;
    hourly: string;
    nowEyebrow: string;
    /** "{name} approved" — the toast after an inline approve. */
    toastApproved: string;
    actionPending?: string;
    actionFailed?: string;
    view: string;
  };
}

export interface TrayStatusPayload {
  /** Pre-formatted running rows, shown as disabled info items. */
  running: TrayRunningRow[];
  /** Kinds whose last run ended in a failure (trayStatus `failedKinds`), so
   *  the notch ends that run on a failure, not on done. */
  failed?: TrayRunningRow["kind"][];
  /** Text next to the tray icon ("72%", "2"); null clears it. */
  title: string | null;
  suggested: string;
  /** Today's-inflow block; null/absent hides the section everywhere. */
  inflow?: TrayInflowPayload | null;
  /** Pending map proposals the panel can approve/reject inline (capped).
   *  Absent/empty hides the rows. */
  proposals?: TrayProposalPayload[];
  proposalApprove?: string;
  proposalReject?: string;
  /** builtin-local caveat shown under the rows; "" when a provider can draft. */
  proposalNote?: string;
  /** Status subtitle under the mascot's name; absent on older payloads. */
  greeting?: string;
  /** Tile counts + labels; null/absent on older payloads hides the tiles. */
  panel?: TrayPanelPayload | null;
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

/** Native identity of one vault opening, including a same-path reopen. */
export interface AgentVaultSession {
  readonly vaultPath: string;
  readonly openingToken: string;
}

/** Public identity of a private native-held Audio source job. */
export interface AudioOverviewJobContext {
  readonly jobId: string;
  readonly origin: AgentVaultSession;
}

/** Public fields cannot recreate the native-held generated draft. */
export interface AudioOverviewDraftContext extends AudioOverviewJobContext {
  readonly draftId: string;
}

export interface AudioOverviewCoverage {
  selectedPages: string[];
  includedPages: string[];
  omittedPages: string[];
  includedBodyRanges: { path: string; startByte: number; endByte: number }[];
  budgetBytes: number;
  includedBodiesOnly: boolean;
}

export interface AudioOverviewDraft {
  title: string;
  turns: { speaker: "A" | "B"; text: string; cites: string[] }[];
  sourcePages: string[];
  context: AudioOverviewDraftContext;
  coverage: AudioOverviewCoverage;
}

export interface AudioOverviewPublication {
  jobId: string;
  draftId: string;
  origin: AgentVaultSession;
  path: string;
  revision: string | null;
  state: "persisted" | "partial";
  error: string | null;
}

/** One image request bound to its initiating native opening and Compilation grant. */
export interface ImageIngestRequest {
  path: string;
  prompt: string;
  origin: AgentVaultSession;
  roleSnapshot: RoleSnapshot;
  requestId: string;
}

/** Native-held exact inbox bytes; public fields cannot recreate its authority. */
export interface InboxSourceSnapshot {
  snapshotId: string;
  origin: AgentVaultSession;
  inboxRel: string;
  sourceRevision: string;
  text: string;
}

export interface InboxArchiveReceipt {
  archivedPath: string;
  sourceRevision: string;
  harvestCompleted: boolean;
}

/** Content claims; only private native publication capabilities prove ownership. */
export interface ArchivePublication {
  path: string;
  revision: string;
  created: boolean;
}

export interface ManagedDistillArtifact {
  kind: "daily" | "weekly" | "monthly" | "map";
  key: string;
}

/** Native persisted-file receipt. Public fields cannot recreate its authority. */
export interface DistillPublicationReceipt {
  publicationId: string;
  operationId: string;
  path: string;
  revision: string;
  fileIdentity: { device: number; inode: number; changedSeconds: number; changedNanoseconds: number };
  nativeCreated: boolean;
  state: "prepared" | "published" | "consumed";
}

export interface ArchiveReceipt {
  manifestId: string;
  moved: { from: string; to: string; revision: string }[];
  pending: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  createdNotePaths: string[];
  retryable: boolean;
}

export interface ArchiveOptions {
  origin: AgentVaultSession;
  manifestId: string;
  publications: ArchivePublication[];
  publicationIds: string[];
}

export interface CliExecutionRequest {
  readonly capability: "read-only" | "staged-write";
  readonly origin: AgentVaultSession;
  readonly roleSnapshot?: RoleSnapshot;
}

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
  closeVault: () => invoke<void>("close_vault", {}),
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
  readEditorFile: (path: string, origin: AgentVaultSession) =>
    invoke<EditorFileSnapshot>("read_editor_file", { path, origin }),
  editorRecoverySupported: () => invoke<boolean>("editor_recovery_supported"),
  readEditorDraft: (path: string, origin: AgentVaultSession) =>
    invoke<RecoveryDraft | null>("read_editor_draft", { path, origin }),
  stageEditorDraft: (
    path: string, expectedSha256: string, draft: string, origin: AgentVaultSession,
    expectedJournalRevision: string | null,
  ) => invoke<RecoveryDraft>("stage_editor_draft", { path, expectedSha256, draft, origin, expectedJournalRevision }),
  retireEditorDraft: (path: string, origin: AgentVaultSession, expectedJournalRevision: string) =>
    invoke<void>("retire_editor_draft", { path, origin, expectedJournalRevision }),
  readStudyDeck: (path: string, origin: AgentVaultSession) =>
    invoke<StudyDeckSnapshot>("read_study_deck", { path, origin }),
  writeStudyDeck: (context: StudyDeckContext, content: string) =>
    invoke<StudyDeckWriteReceipt>("write_study_deck", { context, content }),
  discardStudyDeckSnapshot: (context: StudyDeckContext) =>
    invoke<boolean>("discard_study_deck_snapshot", { context }),
  /** Raw bytes of a `raw/`-confined source file (PDF viewer, Feature 6). */
  readRawBytes: (relpath: string) =>
    invoke<ArrayBuffer>("read_raw_bytes", { relpath }),
  /** Save image bytes under `assets/`; resolves to the vault-relative path. */
  writeAsset: (name: string, bytes: Uint8Array) =>
    invoke<string>("write_asset", bytes, { headers: { "x-myco-name": name } }),
  /** Copy a dropped image file at `src` under `assets/`; resolves like writeAsset. */
  copyAsset: (name: string, src: string) =>
    invoke<string>("copy_asset", { name, src }),
  readVaultContext: (root: string, maxBytes: number) =>
    invoke<string>("read_vault_context", { root, maxBytes }),
  writeFile: (path: string, content: string) =>
    invoke<null>("write_file", { path, content }),
  /** A null precondition means absent, not an existing empty note. */
  writeFileIfUnchanged: (path: string, content: string, expectedSha256: string | null) =>
    invoke<null>("write_file_if_unchanged", { path, content, expectedSha256 }),
  writeEditorFile: (path: string, content: string, expectedSha256: string, origin: AgentVaultSession) =>
    invoke<EditorWriteReceipt>("write_editor_file", { path, content, expectedSha256, origin }),
  writeRunLog: (vaultPath: string, name: string, content: string) =>
    invoke<null>("write_run_log", { vaultPath, name, content }),
  scaffoldObsidianVault: (vaultPath: string) =>
    invoke<string>("scaffold_obsidian_vault", { vaultPath }),
  readExternalText: (path: string) =>
    invoke<string>("read_external_text", { path }),
  fetchYoutubeTranscript: (url: string) =>
    invoke<string>("fetch_youtube_transcript", { url }),
  /** S38 — SSRF-guarded fetch of an article's main text; rejects with a
   *  stable code (see `webLink.ts`). Writes nothing. */
  fetchWebPage: (url: string) => invoke<WebPage>("fetch_web_page", { url }),
  /** Native authority determines the image route; legacy Query fields are not sent. */
  describeImage: (request: ImageIngestRequest) =>
    invoke<string>("describe_image", { request }),
  /** Cancel the exact image attempt; acknowledgement does not recall sent bytes. */
  cancelImageIngest: (origin: AgentVaultSession, requestId: string) =>
    invoke<boolean>("cancel_image_ingest", { origin, requestId }),
  /** Transcribe an audio/video file via an installed whisper CLI (Feature 2). */
  transcribeMedia: (path: string) =>
    invoke<string>("transcribe_media", { path }),
  /** Whether a whisper-family CLI is on PATH (gates the media-ingest button). */
  whisperCheck: () => invoke<ClaudeStatus>("whisper_check"),
  /** Save a spotlight voice capture: whisper-transcribe the recorded audio
   *  into the open vault's `_inbox/voice-<date>.md`. Plain number[] because
   *  invoke args are JSON — a Uint8Array would not reach Rust as Vec<u8>. */
  saveVoiceCapture: (bytes: number[]) =>
    invoke<{ rel: string; first_line: string }>("save_voice_capture", { bytes }),
  /** Live captions: plain transcript of a WAV snapshot of the take so far.
   *  Raw body like writeAsset — a 45 s snapshot is ~1.4 MB every few seconds,
   *  too much for a JSON number array. Emits no progress events. */
  transcribePartial: (bytes: Uint8Array) =>
    invoke<string>("transcribe_partial", bytes),
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
  /** `folder`: one top-level folder only, so `limit` counts its hits. */
  searchVault: (query: string, limit?: number, folder?: string) =>
    invoke<SearchHit[]>("search_vault", { query, limit, folder }),
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
    /** Ask scope (Rust `scope`, default "wiki") and tier priors (Rust
     *  `tier_weights`, default DEFAULT_TIER_WEIGHTS in extractive.ts). */
    scope?: SearchScope,
    tierWeights?: TierWeights,
    /** Vault-relative pages to rank against, with `scope` (Rust `paths`) —
     *  "Ask this note". Omitted = no path filter; [] matches nothing. */
    paths?: string[],
  ) =>
    invoke<SemanticSearchResult>("semantic_search", {
      query,
      k,
      provider,
      model,
      range: range ? queryDateRange(range) : undefined,
      scope,
      tierWeights,
      paths,
    }),
  /** Read original turn dates for topic-free personal activity questions. */
  temporalRecall: (range: { start: string; end: string }, scope: AskScope, paths?: string[]) =>
    invoke<TemporalRecallResult>("temporal_recall", { range: queryDateRange(range), scope, paths }),
  activityRecall: (request: { expectedVault: string; origin: AgentVaultSession; roleSnapshot?: RoleSnapshot; range: { start: string; end: string }; scope: AskScope; paths?: string[] }) =>
    invoke<ActivityRecallResult>("activity_recall", { request: { ...request, range: queryDateRange(request.range) } }),
  /** 2D semantic-map coordinates (PCA over page embeddings) for every indexed page. */
  semanticMap: () => invoke<SemanticPoint[]>("semantic_map", {}),
  /** Existing pages a new source likely relates to — retrieval grounding for ingest. */
  wikifyCandidates: (sourceText: string, k: number) =>
    invoke<CandidatePage[]>("wikify_candidates", { sourceText, k }),
  relatedPages: (page: string, k: number) =>
    invoke<VecHit[]>("related_pages", { page, k }),
  embeddingsStatus: () => invoke<EmbeddingsStatus>("embeddings_status", {}),
  semanticEdges: (k: number) => invoke<SemEdge[]>("semantic_edges", { k }),
  /** Embed arbitrary texts with the bundled local embedder (e5-small-ko) —
   *  used by the extractive session digest to rank candidate quotes offline. */
  embedLocalTexts: (texts: string[]) =>
    invoke<number[][]>("embed_local_texts", { texts }),
  createFile: (parent: string, name: string) =>
    invoke<string>("create_file", { parent, name }),
  createFolder: (parent: string, name: string) =>
    invoke<string>("create_folder", { parent, name }),
  deletePath: (path: string, expectedPermanent?: boolean) => invoke<null>("delete_path", { path, expectedPermanent }),
  /** Delete a list using the persisted deletion policy; paths already gone are
   *  skipped. */
  trashPaths: (paths: string[], expectedPermanent?: boolean) => invoke<null>("trash_paths", { paths, expectedPermanent }),
  renamePath: (from: string, toName: string) =>
    invoke<string>("rename_path", { from, toName }),
  /** Move a file or folder into `toDir` (same name); resolves to the new path. */
  movePath: (from: string, toDir: string) =>
    invoke<string>("move_path", { from, toDir }),
  /** Overwrite `.myco/favorites.json` with vault-relative paths, in star order. */
  saveFavorites: (paths: string[]) =>
    invoke<null>("save_favorites", { paths }),
  archiveInboxSource: (path: string, completeHarvest = false) =>
    invoke<string>("archive_inbox_source", { path, completeHarvest }),
  inboxSourceSnapshot: (origin: AgentVaultSession, rel: string, expectedRevision?: string) =>
    invoke<InboxSourceSnapshot>("inbox_source_snapshot", { origin, inboxRel: rel, expectedRevision }),
  inboxCompileBegin: (snapshot: InboxSourceSnapshot, usage: RoleUsage) =>
    invoke<SessionCompileContext>("inbox_compile_begin", { snapshot, usage }),
  archiveInboxSourceChecked: (snapshot: InboxSourceSnapshot, context?: SessionCompileContext) =>
    invoke<InboxArchiveReceipt>("archive_inbox_source_checked", { snapshot, context }),
  releaseInboxSource: (snapshot: InboxSourceSnapshot) =>
    invoke<void>("release_inbox_source", { snapshot }),
  /** Every file waiting in `_inbox/`, any extension — flat, dotfiles and
   *  subdirectories (quarantine/, .archived/) skipped. */
  listInboxEntries: (vault: string) =>
    invoke<InboxEntry[]>("list_inbox_entries", { vault }),
  availableRawPath: (stem: string) =>
    invoke<string>("available_raw_path", { stem }),
  /** The raw/ file (top level or `raw/archive/**`) whose bytes equal
   *  `content`, vault-relative, or null. Ingest reuses it instead of adding
   *  a copy: raw/ is immutable, so a duplicate could never be removed.
   *  `shared`: another raw copy has the same file stem, so a summary page
   *  named after it would be that body's too. */
  findRawCopy: (content: string) =>
    invoke<{ path: string; shared: boolean } | null>("find_raw_copy", { content }),
  /** For an image or recording in the vault: `marker` names its bytes, and
   *  `copy` is the whole raw copy that already carries that marker, or null.
   *  A retry reuses the text in it instead of describing the file again. */
  derivedRawCopy: (path: string) =>
    invoke<{ marker: string; copy: string | null }>("derived_raw_copy", { path }),
  pickDirectory: async (): Promise<string | null> => {
    const selection = await open({ directory: true, multiple: false });
    return typeof selection === "string" ? selection : null;
  },
  /** Pick an image for the `/image` slash item (copied with copyAsset). */
  pickImageFile: async (): Promise<string | null> => {
    const selection = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Images", extensions: [...IMAGE_EXTS] }],
    });
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
  importConversations: (sourcePath: string, origin: AgentVaultSession, requestId: string) =>
    invoke<ImportOutcome>("import_conversations", { sourcePath, origin, requestId }),
  /** Import every on-disk session for a CLI tool in one pass (dedup-safe). */
  importSessionSweep: (kind: "claude-code" | "codex", origin: AgentVaultSession, requestId: string) =>
    invoke<ImportOutcome>("import_session_sweep", { kind, origin, requestId }),
  /** Re-import an explicit list of files (retry-failed). `dest` must match the
   *  run that produced the failures: "_inbox" books a paid ingest per file,
   *  "sessions" does not. The backend refuses anything else. */
  importPaths: (paths: string[], dest: "_inbox" | "sessions", origin: AgentVaultSession, requestId: string) =>
    invoke<ImportOutcome>("import_paths", { paths, dest, origin, requestId }),
  gitLog: (vaultPath: string, limit?: number) =>
    invoke<GitCommit[]>("git_log", { vaultPath, limit }),
  claudeCheck: () => invoke<ClaudeStatus>("claude_check"),
  claudeRun: (
    prompt: string,
    cwd: string,
    model?: string,
    effort?: string,
    execution?: CliExecutionRequest,
  ) =>
    invoke<ClaudeResult>("claude_run", { prompt, cwd, model, effort, execution }),
  claudeRunStream: (
    runId: string,
    prompt: string,
    cwd: string,
    model?: string,
    effort?: string,
    execution?: CliExecutionRequest,
  ) =>
    invoke<ClaudeResult>("claude_run_stream", {
      runId,
      prompt,
      cwd,
      model,
      effort,
      execution,
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
    execution?: CliExecutionRequest,
  ) =>
    invoke<ClaudeResult>("agent_run", { provider, model, prompt, cwd, effort, execution }),
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
  mycoProIngest: (slug: string, title: string, text: string,
    origin?: AgentVaultSession, roleSnapshot?: RoleSnapshot) =>
    invoke<MycoProResult>("myco_pro_ingest", { slug, title, text, origin, roleSnapshot }),
  mycoProLogin: (email: string, password: string) =>
    invoke<MycoProLogin>("myco_pro_login", { email, password }),
  mycoProLogout: () => invoke<null>("myco_pro_logout"),
  setProviderKey: (providerId: string, key: string) =>
    invoke<null>("set_provider_key", { providerId, key }),
  deleteProviderKey: (providerId: string) =>
    invoke<null>("delete_provider_key", { providerId }),
  getSettings: () => invoke<MycoSettings>("get_settings"),
  captureModelRole: (origin: AgentVaultSession, role: RoleId, usage: RoleUsage = "foreground") =>
    invoke<RoleSnapshot>("capture_model_role", { origin, role, usage }),
  selectModelRole: (request: RoleSelectionRequest) =>
    invoke<MycoSettings>("select_model_role", { request }),
  setRoleAutomaticUse: (role: RoleId, allowed: boolean, expectedAuthorizationRevision: string) =>
    invoke<MycoSettings>("set_role_automatic_use", { role, allowed, expectedAuthorizationRevision }),
  /** Refresh the macOS menu bar tray (menu rows + icon-side title). */
  updateTrayStatus: (status: TrayStatusPayload) =>
    invoke<null>("update_tray_status", { status }),
  /** Last pushed tray snapshot — the tray popover window's data source. */
  getTrayStatus: () => invoke<TrayStatusPayload>("get_tray_status"),
  /** Tray popover quick action; same Rust routing as the native menu rows.
   *  "query" | "distill" | "open" | "quit" | "overview" | "settings" |
   *  "dismiss" (hide the panel only). */
  trayPanelAction: (action: string, scope?: VaultActionScope, requestId?: string) =>
    invoke<null>("tray_panel_action", { action, scope, requestId }),
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
  /** Copy eligible sessions into `_inbox/` under the captured native opening.
   * Native source admission and compilation are separate from copying. */
  promoteSessions: (limit: number, vaultPath: string, origin: AgentVaultSession) =>
    invoke<BackfillPromotion>("promote_sessions", { limit, vaultPath, origin }),
  /** Fit the notch window to the surface in logical px. */
  notchResize: (width: number, height: number) =>
    invoke<null>("notch_resize", { width, height }),
  /** Notch S7: append `- HH:MM <text>` to today's daily note (seeded with its
   *  date heading on first use — PageTasks' addTask convention). The offset
   *  ships the webview's LOCAL clock: daily notes bucket on the user's
   *  calendar day (taskLine.today), and Rust alone only knows UTC. Returns
   *  the vault-relative path and the line written. `source`, the raw/
   *  original a quote cites, adds its footnote definition once per note. */
  captureNote: (text: string, source?: string) =>
    invoke<Captured>("capture_note", {
      text,
      source: source ?? null,
      tzOffsetMin: -new Date().getTimezoneOffset(),
    }),
  /** Ask the notch NSPanel to take key focus so the S7 input can type.
   *  Resolves whether it really became the key window — a nonactivating
   *  panel may refuse; the caller logs the answer either way. */
  notchFocusCapture: () => invoke<boolean>("notch_focus_capture"),
  /** Send myco out of the notch to roam the screen. Resolves whether it went:
   *  not while the notch is hidden or a full-screen app is in front. */
  roamShow: () => invoke<boolean>("roam_show"),
  /** Bring myco back: the roam window orders out. */
  roamHide: () => invoke<null>("roam_hide"),
  /** Where myco roams, or null while it is in the notch — the roam window
   *  asks on load, since it can load after the event that sent myco out. */
  roamPlace: () => invoke<RoamPlace | null>("roam_place"),
  /** Apply the notch toggle live (show/hide the window). Persisting the flag
   *  itself goes through set_settings like every other setting. */
  updateNotchEnabled: (enabled: boolean) =>
    invoke<null>("update_notch_enabled", { enabled }),
  setSettings: (value: MycoSettings) => invoke<MycoSettings>("set_settings", { value }),
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
  chatComplete: (request: ChatRequest, origin?: AgentVaultSession, roleSnapshot?: RoleSnapshot) =>
    invoke<ChatResponse>("chat_complete", { request, origin, roleSnapshot }),
  // In-app agent (Feature 4).
  agentVaultSession: () =>
    invoke<AgentVaultSession>("agent_vault_session", {}),
  audioOverviewBegin: (origin: AgentVaultSession, pagePaths: string[], title: string, dateIso: string) =>
    invoke<AudioOverviewJobContext>("audio_overview_begin", { origin, pagePaths, title, dateIso }),
  audioOverviewGenerate: (context: AudioOverviewJobContext) =>
    invoke<AudioOverviewDraft>("audio_overview_generate", { context }),
  audioOverviewPublish: (context: AudioOverviewDraftContext) =>
    invoke<AudioOverviewPublication>("audio_overview_publish", { context }),
  audioOverviewCancel: (context: AudioOverviewJobContext) =>
    invoke<boolean>("audio_overview_cancel", { context }),
  publishDistillNote: (
    origin: AgentVaultSession,
    operationId: string,
    artifact: ManagedDistillArtifact,
    content: string,
    expectedSha256: string | null,
    roleSnapshot?: RoleSnapshot,
  ) => {
    if (!origin?.vaultPath || !origin.openingToken) return Promise.reject(new Error("Native publication requires a vault opening identity"));
    if (!roleSnapshot) return Promise.reject(new Error("Managed publication requires its generation role snapshot"));
    return invoke<DistillPublicationReceipt>("publish_distill_note", { origin, operationId, artifact, content, expectedSha256, roleSnapshot });
  },
  agentToolsSchema: () =>
    invoke<AgentToolDescriptor[]>("agent_tools_schema", {}),
  agentToolCall: (
    name: string,
    args: Record<string, unknown>,
    allowWrite: boolean,
    origin: AgentVaultSession,
  ) => invoke<unknown>("agent_tool_call", { name, args, allowWrite, origin }),
  /** Resolve or create a missing Reflect target within its original opening. */
  reflectCreateMissingPage: (origin: AgentVaultSession, target: string) =>
    invoke<string>("reflect_create_missing_page", { origin, target }),
  agentChat: (request: AgentChatRequest, origin?: AgentVaultSession, roleSnapshot?: RoleSnapshot) =>
    invoke<AgentTurn>("agent_chat", { request, origin, roleSnapshot }),
  // Distillation config (Task 2, Phase A).
  getDistillConfig: (vault: string) =>
    invoke<DistillConfig>("get_distill_config", { vault }),
  setDistillConfig: (vault: string, config: DistillConfig) =>
    invoke<null>("set_distill_config", { vault, config }),
  // Idle-run orchestrator: trash, manifest, undo (Task 6, Phase A). It never
  // touches raw/.
  distillRun: (vault: string) => invoke<RunReport>("distill_run", { vault }),
  undoDistillRun: async (vault: string, id: string) => {
    const origin = await invoke<AgentVaultSession>("agent_vault_session", {});
    if (origin?.vaultPath !== vault || !origin.openingToken) throw new Error("Undo requires the current vault opening; preserve artifacts for manual recovery");
    return invoke<number>("undo_distill_run", { vault, id, origin });
  },
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
  /** One page's content at a revision (`<sha>` or `<sha>^`); null when the
   *  path did not exist there. Backs the reader's per-paragraph revert. */
  pageAtRevision: (vault: string, rel: string, rev: string) =>
    invoke<string | null>("page_at_revision", { vault, rel, rev }),
  // Morning-Report suspect scan (Q4 item 2).
  suspectPages: (vault: string) =>
    invoke<SuspectReport>("suspect_pages", { vault }),
  // Recall miss log (Q4 item 5).
  recordRecallMiss: (vault: string, query: string, expected?: string) =>
    invoke<null>("record_recall_miss", { vault, query, expected }),
  // Page-open tracking (Q4 item 10) — feeds resurface dormancy.
  recordPageOpen: (vault: string, rel: string) =>
    invoke<null>("record_page_open", { vault, rel }),
  /** This device's Ask history for the open vault, oldest first (UX S36). */
  askHistoryLoad: (vault: string) => invoke<AskRecord[]>("ask_history_load", { vault }),
  askHistoryAppend: (vault: string, turn: AskRecord) =>
    invoke<null>("ask_history_append", { vault, turn }),
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
  // button. The caller retains the native opening captured for this action.
  // Missing legacy authority is refused rather than refreshed implicitly.
  archiveUsage: (vault: string, origin?: AgentVaultSession) => {
    if (origin?.vaultPath !== vault || !origin.openingToken) return Promise.reject(new Error("Archive measurement requires the captured vault opening"));
    return invoke<BucketUsage[]>("archive_usage", { vault, origin });
  },
  compressArchives: (vault: string, olderThanMonths: number, origin?: AgentVaultSession) => {
    if (origin?.vaultPath !== vault || !origin.openingToken) return Promise.reject(new Error("Archive compaction requires the captured vault opening"));
    return invoke<PackReport>("compress_archives", { vault, olderThanMonths, origin });
  },
  restoreArchiveBucket: (vault: string, tree: ArchiveTree, bucket: string, origin?: AgentVaultSession) => {
    if (origin?.vaultPath !== vault || !origin.openingToken) return Promise.reject(new Error("Archive restore requires the captured vault opening"));
    return invoke<RestoreReport>("restore_archive_bucket", { vault, tree, bucket, origin });
  },
  // Execute a pending distill proposal (Task 7, Phase A).
  applyDistillProposal: (vault: string, path: string, expectedPermanent?: boolean) =>
    invoke<string>("apply_distill_proposal", { vault, path, expectedPermanent }),
  // Quarantine review (ROADMAP P0): list what the gate held back, and the two
  // resolutions that need Rust — restore goes through the same re-admit path
  // an approved admit-cluster proposal takes, keep-longer bumps the sidecar
  // TTL. Delete is `trashPaths`, using the persisted deletion policy.
  listQuarantine: (vault: string) =>
    invoke<QuarantineItem[]>("list_quarantine", { vault }),
  restoreQuarantine: (vault: string, files: string[]) =>
    invoke<string>("restore_quarantine", { vault, files }),
  extendQuarantine: (vault: string, files: string[], days: number, origin?: AgentVaultSession) => {
    if (origin?.vaultPath !== vault || !origin.openingToken) return Promise.reject(new Error("Keep requires the captured vault opening"));
    return invoke<number>("extend_quarantine", { vault, files, days, origin });
  },
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
    options: ArchiveOptions,
  ) => {
    if (options?.origin?.vaultPath !== vault || !options.origin.openingToken || !options.publicationIds?.length) return Promise.reject(new Error("Archive requires native publication capabilities; preserve sources for manual recovery"));
    return invoke<ArchiveReceipt>("archive_digested_sessions", {
      vault,
      day,
      files,
      fingerprints,
      ...options,
    });
  },
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
    options: ArchiveOptions,
  ) => {
    if (options?.origin?.vaultPath !== vault || !options.origin.openingToken || !options.publicationIds?.length) return Promise.reject(new Error("Archive requires native publication capabilities; preserve sources for manual recovery"));
    return invoke<ArchiveReceipt>("archive_rolled", {
      vault,
      layer,
      bucket,
      files,
      fingerprints,
      ...options,
    });
  },
  // Gate-admitted Full-tier items ready for LLM ingest (Phase B, Task 3).
  fullTierItems: (vault: string) =>
    invoke<string[]>("full_tier_items", { vault }),
  listWikifyPending: (expectedVault: string, origin: AgentVaultSession, limit = 3) =>
    invoke<{ pendingTotal: number; items: SessionQueueItem[] }>("list_wikify_pending", { expectedVault, origin, limit }),
  sessionSummaryPath: (expectedVault: string, key: string, sourceRevision: string, origin: AgentVaultSession) =>
    invoke<string | null>("session_summary_path", { expectedVault, key, sourceRevision, origin }),
  wikifyCompleteSource: (context: SessionCompileContext, wikiPaths: string[]) =>
    invoke<SessionCompileOutcome>("wikify_complete_source", { vault: context.origin.vaultPath,
      origin: context.origin, rawPath: context.source.rawPath, sourceRevision: context.source.sourceRevision,
      wikiPaths, sessionCompile: context }),
  sessionCompileBegin: (origin: AgentVaultSession, source: SessionSourceBinding, usage: RoleUsage = "foreground") =>
    invoke<SessionCompileContext>("session_compile_begin", { origin, source, usage }),
  sessionCompileRead: (context: SessionCompileContext, path: string) =>
    invoke<{ raw: string; revision: string }>("session_compile_read", { context, path }),
  sessionCompilePublish: (context: SessionCompileContext, path: string, content: string, expectedRevision: string | null) =>
    invoke<{ publicationId: string; attemptId: string; path: string; revision: string; nativeCreated: boolean }>("session_compile_publish", { context, path, content, expectedRevision }),
  sessionCompileStop: (context: SessionCompileContext, reason: string) =>
    invoke<void>("session_compile_stop", { context, reason }),
  sessionCompileStep: (context: SessionCompileContext, requestId: string, lang: "ko" | "en" | "ja") =>
    invoke<SessionCompileStepResult>("session_compile_step", { context, requestId, lang }),
  // Record native-issued managed-note publications in the undo manifest.
  // Arbitrary moves or SHA-only creation claims require manual recovery;
  // private native move receipts and restart recovery remain separate work.
  appendDistillManifest: (
    vault: string,
    id: string,
    moves: { from: string; to: string }[],
    created: string[],
    origin: AgentVaultSession,
    createdRevisions: ArchivePublication[] = [],
    publicationIds: string[] = [],
  ) => {
    if (origin?.vaultPath !== vault || !origin.openingToken || !publicationIds.length) return Promise.reject(new Error("Manifest requires native publication capabilities; preserve artifacts for manual recovery"));
    return invoke<null>("append_distill_manifest", { vault, id, moves, created, origin, createdRevisions, publicationIds });
  },
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
  saveDashboard: (name: string, content: string, vaultPath?: string) =>
    invoke<void>("save_dashboard", { name, content, vaultPath }),
  /** Saved board names (file stems) — the file listing IS the list. */
  listDashboards: () => invoke<string[]>("list_dashboards"),
  deleteDashboard: (name: string) =>
    invoke<void>("delete_dashboard", { name }),
  /** Saved Views (`.myco/views/<name>.json`) — same name rules as boards. */
  saveView: (name: string, content: string) =>
    invoke<void>("save_view", { name, content }),
  listViews: () => invoke<string[]>("list_views"),
  deleteView: (name: string) => invoke<void>("delete_view", { name }),
  /** The vault's plugin manifests, read-only and confined to
   *  `.myco/plugins/` (lib/plugins.ts validates them). */
  listPlugins: () => invoke<PluginFile[]>("list_plugins"),
  mcpConnect: () => invoke<string>("mcp_connect"),
  // Embedded local model (bundled Gemma 3 1B) — offline, no key. First call
  // lazily loads the weights, so it can take a few extra seconds.
  localQuery: (prompt: string, maxTokens?: number, origin?: AgentVaultSession, roleSnapshot?: RoleSnapshot, requestId?: string) =>
    invoke<string>("local_query", { prompt, maxTokens, origin, roleSnapshot, requestId }),
  // Cheap `is_file()` check (no model load) — no chat GGUF has shipped since
  // Ask went extractive, so this is normally always false.
  localChatModelAvailable: () => invoke<boolean>("local_chat_model_available"),
  localChatStatus: (modelId?: string) => invoke<LocalChatStatus>("local_chat_status", modelId ? { modelId } : undefined),
  localQueryPlan: (request: LocalQueryPlanRequest) => invoke<LocalQueryPlan>("local_query_plan", { request }),
  localSynthesize: (request: LocalSynthesisRequest) =>
    invoke<LocalSynthesisResult>("local_synthesize", { request: {
      ...request, range: request.range ? queryDateRange(request.range) : undefined,
    } }),
  localTransform: (request: LocalTransformRequest) =>
    invoke<LocalSynthesisResult>("local_transform", { request }),
  cancelLocalSynthesis: (requestId: string) =>
    invoke<boolean>("cancel_local_synthesis", { requestId }),
  downloadLocalChatModel: (modelId?: string) => invoke<LocalChatStatus>("download_local_chat_model", modelId ? { modelId } : undefined),
  cancelLocalChatModelDownload: () => invoke<boolean>("cancel_local_chat_model_download"),
  // ROADMAP P2 — crash report viewer (Settings -> About).
  recentPanics: (limit: number) =>
    invoke<PanicEntry[]>("recent_panics", { limit }),
  clearPanicLog: () => invoke<null>("clear_panic_log"),
  osVersion: () => invoke<string>("os_version"),
  // Harvest queue (Overview) + judgement stage (Ingest). Multi-word args go
  // camelCase like every wrapper above (Tauri 2's default arg-key mapping).
  /** Sessions worth promoting, ranked by nearest wiki cluster, plus the
   *  buckets the ranker refused — the queue is honest about what it hides. */
  harvestCandidates: (limit = 20, vaultPath?: string) =>
    invoke<HarvestCandidates>("harvest_candidates", { limit, vaultPath }),
  /** Copy selected originals into `_inbox/` with first-read revision bindings.
   * Copy metadata cannot attest native compilation or harvest completion. */
  harvestRun: (paths: string[], vaultPath: string, origin: AgentVaultSession) =>
    invoke<HarvestRunResult>("harvest_run", { paths, vaultPath, origin }),
  /** Drop / log / harvest verdict for a source BEFORE any file is written. */
  judgeSource: (text: string, size_bytes: number) =>
    invoke<SourceVerdict>("judge_source", { text, sizeBytes: size_bytes }),
  /** One judgement-log line for a source that produced no files. */
  recordNoop: (rel: string, reason: string) =>
    invoke<void>("record_noop", { rel, reason }),
};

// --- Harvest queue / judgement types (harvest_candidates & co.) -------------

export interface HarvestCandidate {
  /** Absolute path of the session file. */
  path: string;
  /** Vault-relative path (`sessions/<name>`). */
  rel: string;
  size_bytes: number;
  /** Epoch seconds. */
  mtime: number;
  title: string;
  /** Opening lines of the transcript, speaker labels kept (`[User] …`). */
  preview: string[];
  /** Nearest existing wiki page and its similarity; null when unindexed. */
  cluster: { page: string; score: number } | null;
  est_citations: number;
  kind: "session" | "raw";
}

/** Why a scanned file is NOT in the queue, by bucket. Fixed key set — the
 *  exclusion table renders them in `EXCLUDED_ORDER` (harvest.ts). */
export interface HarvestExcluded {
  duplicate: number;
  boilerplate: number;
  too_small: number;
  too_large: number;
  already_harvested: number;
}

export interface HarvestCandidates {
  read_status: SessionReadStatus;
  read_issues: SessionReadIssue[];
  items: HarvestCandidate[];
  excluded: HarvestExcluded;
  total_scanned: number;
  distinct_bodies: number;
  /** Candidates before the `limit` cut — "20 of 137". */
  eligible: number;
}

export interface HarvestRunResult {
  copied: number;
  /** `_inbox/<name>` of every copy that landed. */
  inbox_rels: string[];
  /** Native first-copy revisions, retained through every bounded pass. */
  inbox_sources: { source_rel: string; inbox_rel: string; source_revision: string }[];
  skipped: { path: string; reason: string }[];
}

export interface SourceVerdict {
  verdict: "drop" | "log" | "harvest";
  reason: string;
  /** The rule that decided, e.g. `junk_reason::min_bytes`. */
  rule: string;
}
