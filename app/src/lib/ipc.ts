// Type-safe wrappers around Tauri invoke calls. Keep this file thin: it must
// reflect the Rust command signatures in src-tauri/src/commands.rs.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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

export interface McpRegInfo {
  found: boolean;
  installed: boolean;
  serving: boolean;
  url: string | null;
  python: string | null;
  script: string | null;
  command: string | null;
  desktop_json: string | null;
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
  done: boolean;
}

export interface ProvenanceRow {
  path: string;
  name: string;
  cited: number;
  total: number;
  /** Distinct sources this page cites, resolved to their raw provenance. */
  sources: SourceRef[];
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

export interface SemanticPoint {
  page: string;
  x: number;
  y: number;
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

export interface MemexSettings {
  providers: {
    anthropic_cli: boolean;
    gemini_cli: boolean;
    codex_cli: boolean;
    anthropic_api: boolean;
    openai_api: boolean;
    google_api: boolean;
    ollama: boolean;
    openrouter: boolean;
    memex_pro: boolean;
    /** Embedded model (bundled GGUF) — ships in the app, on by default. */
    builtin_local: boolean;
  };
  query_provider: string;
  query_model: string;
  ingest_provider: string;
  ingest_model: string;
  /** Memex Pro proxy base URL (the subscription ingest endpoint). */
  memex_pro_url: string;
  /** The Memex Pro account email the app is logged in as (display only). */
  memex_pro_email: string;
  /** Periodically ingest pending _inbox/ sources while the app is open. */
  auto_ingest_enabled: boolean;
  auto_ingest_interval_min: number;
  /** Periodically run a read-only reflect pass while the app is open. */
  auto_reflect_enabled: boolean;
  auto_reflect_interval_min: number;
  /** Re-embed changed pages while the app is open (maintains an existing index
   *  only; the first build stays a deliberate action). */
  auto_reindex_enabled: boolean;
}

export interface MemexProResult {
  summary: string;
  applied: number;
  paths: string[];
}

export interface MemexProLogin {
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

export type ScheduleKind = "query" | "changed" | "stale" | "topic";

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
  listFiles: (root: string) => invoke<FileNode[]>("list_files", { root }),
  fileMtimes: (root: string) =>
    invoke<[string, number][]>("file_mtimes", { root }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  /** Raw bytes of a `raw/`-confined source file (PDF viewer, Feature 6). */
  readRawBytes: (relpath: string) =>
    invoke<ArrayBuffer>("read_raw_bytes", { relpath }),
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
  describeImage: (provider: string, model: string, path: string, prompt: string) =>
    invoke<string>("describe_image", { provider, model, path, prompt }),
  /** Transcribe an audio/video file via an installed whisper CLI (Feature 2). */
  transcribeMedia: (path: string) =>
    invoke<string>("transcribe_media", { path }),
  /** Whether a whisper-family CLI is on PATH (gates the media-ingest button). */
  whisperCheck: () => invoke<ClaudeStatus>("whisper_check"),
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
  semanticSearch: (query: string, k: number, provider: string, model: string) =>
    invoke<VecHit[]>("semantic_search", { query, k, provider, model }),
  /** 2D semantic-map coordinates (PCA over page embeddings) for every indexed page. */
  semanticMap: () => invoke<SemanticPoint[]>("semantic_map", {}),
  /** Existing pages a new source likely relates to — retrieval grounding for ingest. */
  wikifyCandidates: (sourceText: string, k: number) =>
    invoke<CandidatePage[]>("wikify_candidates", { sourceText, k }),
  relatedPages: (page: string, k: number) =>
    invoke<VecHit[]>("related_pages", { page, k }),
  embeddingsStatus: () =>
    invoke<EmbeddingsStatus>("embeddings_status", {}),
  semanticEdges: (k: number) =>
    invoke<SemEdge[]>("semantic_edges", { k }),
  createFile: (parent: string, name: string) =>
    invoke<string>("create_file", { parent, name }),
  createFolder: (parent: string, name: string) =>
    invoke<string>("create_folder", { parent, name }),
  deletePath: (path: string) => invoke<null>("delete_path", { path }),
  renamePath: (from: string, toName: string) =>
    invoke<string>("rename_path", { from, toName }),
  archiveInboxSource: (path: string) =>
    invoke<string>("archive_inbox_source", { path }),
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
  /** Re-import an explicit list of files (retry-failed). */
  importPaths: (paths: string[]) =>
    invoke<ImportOutcome>("import_paths", { paths }),
  gitLog: (vaultPath: string, limit?: number) =>
    invoke<GitCommit[]>("git_log", { vaultPath, limit }),
  claudeCheck: () => invoke<ClaudeStatus>("claude_check"),
  claudeRun: (prompt: string, cwd: string, model?: string) =>
    invoke<ClaudeResult>("claude_run", { prompt, cwd, model }),
  claudeRunStream: (runId: string, prompt: string, cwd: string, model?: string) =>
    invoke<ClaudeResult>("claude_run_stream", { runId, prompt, cwd, model }),
  claudeCancel: (runId: string) =>
    invoke<boolean>("claude_cancel", { runId }),
  agentCheck: (provider: string) =>
    invoke<ClaudeStatus>("agent_check", { provider }),
  agentRun: (provider: string, model: string, prompt: string, cwd: string) =>
    invoke<ClaudeResult>("agent_run", { provider, model, prompt, cwd }),
  scanTasks: (vaultPath: string) =>
    invoke<TaskItem[]>("scan_tasks", { vaultPath }),
  scanProvenance: (vaultPath: string) =>
    invoke<ProvenanceRow[]>("scan_provenance", { vaultPath }),
  memexProIngest: (slug: string, title: string, text: string) =>
    invoke<MemexProResult>("memex_pro_ingest", { slug, title, text }),
  memexProLogin: (email: string, password: string) =>
    invoke<MemexProLogin>("memex_pro_login", { email, password }),
  memexProLogout: () => invoke<null>("memex_pro_logout"),
  setProviderKey: (providerId: string, key: string) =>
    invoke<null>("set_provider_key", { providerId, key }),
  deleteProviderKey: (providerId: string) =>
    invoke<null>("delete_provider_key", { providerId }),
  getSettings: () => invoke<MemexSettings>("get_settings"),
  setSettings: (value: MemexSettings) =>
    invoke<null>("set_settings", { value }),
  chatComplete: (request: ChatRequest) =>
    invoke<ChatResponse>("chat_complete", { request }),
  // In-app agent (Feature 4).
  agentToolsSchema: () =>
    invoke<AgentToolDescriptor[]>("agent_tools_schema", {}),
  agentToolCall: (name: string, args: Record<string, unknown>, allowWrite: boolean) =>
    invoke<unknown>("agent_tool_call", { name, args, allowWrite }),
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
  listProviderModels: (providerId: string) =>
    invoke<string[]>("list_provider_models", { providerId }),
  ollamaStatus: () => invoke<OllamaStatus>("ollama_status"),
  ollamaInstallUrl: () => invoke<string>("ollama_install_url"),
  openExternal: (url: string) => invoke<null>("open_external", { url }),
  mcpRegistrationInfo: (vaultPath: string) =>
    invoke<McpRegInfo>("mcp_registration_info", { vaultPath }),
  mcpInstall: (vaultPath: string) =>
    invoke<string>("mcp_install", { vaultPath }),
  mcpRegister: (vaultPath: string) =>
    invoke<string>("mcp_register", { vaultPath }),
  mcpServe: () => invoke<string>("mcp_serve"),
  mcpStop: () => invoke<string>("mcp_stop"),
  // Embedded local model (bundled Gemma 3 1B) — offline, no key. First call
  // lazily loads the weights, so it can take a few extra seconds.
  localClassify: (note: string) => invoke<string>("local_classify", { note }),
  localQuery: (prompt: string, maxTokens?: number) =>
    invoke<string>("local_query", { prompt, maxTokens }),
};
