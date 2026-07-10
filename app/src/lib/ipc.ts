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

export interface ProvenanceRow {
  path: string;
  name: string;
  cited: number;
  total: number;
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

export interface EmbeddingsStatus {
  indexed_pages: number;
  model: string;
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
  buildLinkGraph: (root: string) =>
    invoke<Adjacency>("build_link_graph", { root }),
  searchVault: (query: string, limit?: number) =>
    invoke<SearchHit[]>("search_vault", { query, limit }),
  // Semantic layer (Feature 1): embedding index over wiki pages.
  reindexEmbeddings: (provider: string, model: string) =>
    invoke<number>("reindex_embeddings", { provider, model }),
  semanticSearch: (query: string, k: number, provider: string, model: string) =>
    invoke<VecHit[]>("semantic_search", { query, k, provider, model }),
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
          ],
        },
      ],
    });
    return typeof selection === "string" ? selection : null;
  },
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
  // Embedded local model (bundled SEED 0.5B) — offline, no key. First call
  // lazily loads the weights, so it can take a few extra seconds.
  localClassify: (note: string) => invoke<string>("local_classify", { note }),
  localQuery: (prompt: string, maxTokens?: number) =>
    invoke<string>("local_query", { prompt, maxTokens }),
};
