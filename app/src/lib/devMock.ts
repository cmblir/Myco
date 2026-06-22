// DEV-ONLY Tauri IPC mock. Lets the React UI run in a plain browser (vite dev)
// with a large sample vault, so screenshots / visual QA can be captured with
// Playwright without the native shell. Activated only when:
//   import.meta.env.DEV === true  AND  the URL has ?mock=1
// so it is dead-code-eliminated from production bundles (the dmg never ships it).
//
// It installs window.__TAURI_INTERNALS__.invoke with an in-memory implementation
// backed by the same sample-graph topology the Rust seed uses, so the Graph,
// Overview, Provenance and Reader views render real-looking content.

interface Node {
  s: string; // slug
  t: "concept" | "technique" | "entity" | "source-summary" | "analysis";
  n: string; // title
  l: string[]; // links (slugs)
}

// Same topology as src-tauri/src/sample_vault.rs (kept in sync as demo data).
const NODES: Node[] = [
  { s: "transformer-architecture", t: "concept", n: "Transformer Architecture", l: ["attention-mechanism", "embeddings", "tokenization", "positional-encoding", "residual-connections", "feedforward-network", "scaling-laws", "source-attention-is-all-you-need"] },
  { s: "attention-mechanism", t: "technique", n: "Attention Mechanism", l: ["transformer-architecture", "self-attention", "multi-head-attention", "embeddings", "kv-cache", "source-attention-is-all-you-need"] },
  { s: "self-attention", t: "technique", n: "Self-Attention", l: ["attention-mechanism", "multi-head-attention"] },
  { s: "multi-head-attention", t: "technique", n: "Multi-Head Attention", l: ["attention-mechanism", "self-attention"] },
  { s: "embeddings", t: "concept", n: "Embeddings", l: ["transformer-architecture", "tokenization", "attention-mechanism", "vector-database"] },
  { s: "tokenization", t: "technique", n: "Tokenization", l: ["embeddings", "byte-pair-encoding", "transformer-architecture"] },
  { s: "byte-pair-encoding", t: "technique", n: "Byte-Pair Encoding", l: ["tokenization"] },
  { s: "positional-encoding", t: "technique", n: "Positional Encoding", l: ["transformer-architecture", "attention-mechanism"] },
  { s: "residual-connections", t: "concept", n: "Residual Connections", l: ["transformer-architecture", "layer-normalization"] },
  { s: "layer-normalization", t: "technique", n: "Layer Normalization", l: ["transformer-architecture", "residual-connections"] },
  { s: "feedforward-network", t: "concept", n: "Feedforward Network", l: ["transformer-architecture"] },
  { s: "scaling-laws", t: "concept", n: "Scaling Laws", l: ["transformer-architecture", "pretraining", "compute-budget", "source-scaling-laws-paper", "analysis-scaling-vs-data"] },
  { s: "pretraining", t: "technique", n: "Pretraining", l: ["scaling-laws", "fine-tuning", "transformer-architecture"] },
  { s: "compute-budget", t: "concept", n: "Compute Budget", l: ["scaling-laws", "quantization"] },
  { s: "fine-tuning", t: "technique", n: "Fine-tuning", l: ["pretraining", "instruction-tuning", "rlhf", "lora"] },
  { s: "instruction-tuning", t: "technique", n: "Instruction Tuning", l: ["fine-tuning", "rlhf"] },
  { s: "rlhf", t: "technique", n: "RLHF", l: ["fine-tuning", "dpo", "reward-modeling", "alignment", "anthropic", "openai"] },
  { s: "dpo", t: "technique", n: "Direct Preference Optimization", l: ["rlhf", "alignment", "analysis-rlhf-vs-dpo"] },
  { s: "reward-modeling", t: "concept", n: "Reward Modeling", l: ["rlhf", "alignment"] },
  { s: "lora", t: "technique", n: "LoRA", l: ["fine-tuning", "quantization"] },
  { s: "quantization", t: "technique", n: "Quantization", l: ["lora", "distillation", "inference-optimization", "compute-budget"] },
  { s: "distillation", t: "technique", n: "Knowledge Distillation", l: ["quantization", "fine-tuning"] },
  { s: "inference-optimization", t: "concept", n: "Inference Optimization", l: ["quantization", "kv-cache"] },
  { s: "kv-cache", t: "technique", n: "KV Cache", l: ["inference-optimization", "attention-mechanism"] },
  { s: "alignment", t: "concept", n: "Alignment", l: ["rlhf", "constitutional-ai", "interpretability", "reward-modeling", "anthropic"] },
  { s: "constitutional-ai", t: "technique", n: "Constitutional AI", l: ["alignment", "anthropic", "rlhf", "source-constitutional-ai-paper"] },
  { s: "interpretability", t: "concept", n: "Interpretability", l: ["alignment", "anthropic"] },
  { s: "in-context-learning", t: "concept", n: "In-Context Learning", l: ["transformer-architecture", "chain-of-thought", "prompting"] },
  { s: "chain-of-thought", t: "technique", n: "Chain-of-Thought", l: ["in-context-learning", "prompting", "reasoning"] },
  { s: "prompting", t: "technique", n: "Prompting", l: ["in-context-learning", "chain-of-thought", "rag"] },
  { s: "rag", t: "technique", n: "Retrieval-Augmented Generation", l: ["embeddings", "vector-database", "prompting", "tool-use"] },
  { s: "vector-database", t: "concept", n: "Vector Database", l: ["rag", "embeddings"] },
  { s: "tool-use", t: "technique", n: "Tool Use", l: ["agents", "function-calling", "rag", "mcp"] },
  { s: "function-calling", t: "technique", n: "Function Calling", l: ["tool-use", "agents"] },
  { s: "agents", t: "concept", n: "Agents", l: ["tool-use", "mcp", "chain-of-thought", "planning", "reasoning"] },
  { s: "mcp", t: "concept", n: "Model Context Protocol", l: ["tool-use", "agents", "anthropic"] },
  { s: "planning", t: "concept", n: "Planning", l: ["agents", "reasoning"] },
  { s: "reasoning", t: "concept", n: "Reasoning", l: ["chain-of-thought", "planning", "agents"] },
  { s: "openai", t: "entity", n: "OpenAI", l: ["gpt-4", "scaling-laws", "rlhf"] },
  { s: "anthropic", t: "entity", n: "Anthropic", l: ["claude", "constitutional-ai", "alignment", "mcp", "rlhf"] },
  { s: "google-deepmind", t: "entity", n: "Google DeepMind", l: ["gemini", "transformer-architecture", "attention-mechanism"] },
  { s: "meta-ai", t: "entity", n: "Meta AI", l: ["llama", "lora"] },
  { s: "gpt-4", t: "entity", n: "GPT-4", l: ["openai", "transformer-architecture", "rlhf"] },
  { s: "claude", t: "entity", n: "Claude", l: ["anthropic", "constitutional-ai", "mcp"] },
  { s: "gemini", t: "entity", n: "Gemini", l: ["google-deepmind", "transformer-architecture"] },
  { s: "llama", t: "entity", n: "Llama", l: ["meta-ai", "fine-tuning", "lora"] },
  { s: "source-attention-is-all-you-need", t: "source-summary", n: "Source: Attention Is All You Need", l: ["transformer-architecture", "attention-mechanism"] },
  { s: "source-scaling-laws-paper", t: "source-summary", n: "Source: Scaling Laws for Neural Language Models", l: ["scaling-laws", "pretraining"] },
  { s: "source-constitutional-ai-paper", t: "source-summary", n: "Source: Constitutional AI", l: ["constitutional-ai", "anthropic"] },
  { s: "analysis-scaling-vs-data", t: "analysis", n: "Scaling vs. Data Quality", l: ["scaling-laws", "pretraining", "transformer-architecture"] },
  { s: "analysis-rlhf-vs-dpo", t: "analysis", n: "RLHF vs. DPO", l: ["rlhf", "dpo", "alignment"] },
];

const VAULT = "/Memex";
const SLUGS = new Set(NODES.map((d) => d.s));
const pathOf = (s: string): string => `${VAULT}/wiki/${s}.md`;

function buildAdjacency() {
  const forward: Record<string, string[]> = {};
  const backward: Record<string, string[]> = {};
  const tags: Record<string, string[]> = {};
  for (const d of NODES) {
    tags[pathOf(d.s)] = [d.t];
    for (const tgt of d.l) {
      if (!SLUGS.has(tgt)) continue;
      (forward[pathOf(d.s)] ||= []).push(pathOf(tgt));
      (backward[pathOf(tgt)] ||= []).push(pathOf(d.s));
    }
  }
  return { forward, backward, unresolved: {}, tags };
}

function body(d: Node): string {
  const links = d.l.filter((x) => SLUGS.has(x));
  const linkText = links.map((x) => `[[${x}]]`).join(", ");
  return `${d.n} is a core topic in this sample knowledge graph[^src-attention-is-all-you-need]. It connects to ${linkText}. This page ships as starter content so the graph is populated.\n\n[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]\n`;
}

function frontmatter(d: Node): Record<string, unknown> {
  return {
    title: d.n,
    type: d.t,
    created: "2024-02-01",
    last_updated: "2024-03-01",
    source_count: 1,
    confidence: "high",
    status: "active",
  };
}

function fileTree() {
  const wikiChildren = [
    { kind: "file", name: "index.md", path: `${VAULT}/wiki/index.md` },
    { kind: "file", name: "log.md", path: `${VAULT}/wiki/log.md` },
    ...NODES.map((d) => ({ kind: "file", name: `${d.s}.md`, path: pathOf(d.s) })),
  ];
  return [
    { kind: "file", name: "CLAUDE.md", path: `${VAULT}/CLAUDE.md` },
    { kind: "file", name: "welcome.md", path: `${VAULT}/welcome.md` },
    { kind: "directory", name: "daily", path: `${VAULT}/daily`, children: [] },
    { kind: "directory", name: "ingest-reports", path: `${VAULT}/ingest-reports`, children: [] },
    { kind: "directory", name: "raw", path: `${VAULT}/raw`, children: [] },
    { kind: "directory", name: "wiki", path: `${VAULT}/wiki`, children: wikiChildren },
  ];
}

function mtimes(): [string, number][] {
  const base = 1_700_000_000;
  return NODES.map((d, i) => [pathOf(d.s), base + i * 3600] as [string, number]);
}

function provenance() {
  return NODES.map((d) => ({
    path: pathOf(d.s),
    name: `${d.s}.md`,
    cited: 1,
    total: d.t === "analysis" ? 3 : 2,
  }));
}

const SETTINGS = {
  providers: { anthropic_api: false, openai_api: false, google_api: false, ollama: false, openrouter: false },
  query_provider: "anthropic-cli",
  query_model: "claude-sonnet-4-6",
  ingest_provider: "anthropic-cli",
  ingest_model: "claude-sonnet-4-6",
};

const bySlug = new Map(NODES.map((d) => [d.s, d]));

function mockInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case "ensure_default_vault":
      return Promise.resolve(VAULT);
    case "open_vault":
      return Promise.resolve({ path: VAULT, name: "Memex" });
    case "list_files":
      return Promise.resolve(fileTree());
    case "file_mtimes":
      return Promise.resolve(mtimes());
    case "build_link_graph":
      return Promise.resolve(buildAdjacency());
    case "search_vault": {
      const needle = String(args.query ?? "")
        .trim()
        .toLowerCase();
      if (!needle) return Promise.resolve([]);
      const limit = Number(args.limit ?? 50);
      const hits: unknown[] = [];
      for (const d of NODES) {
        if (hits.length >= limit) break;
        const lines = `# ${d.n}\n\n${body(d)}`.split("\n");
        const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
        if (i >= 0)
          hits.push({
            path: pathOf(d.s),
            name: `${d.s}.md`,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 140),
          });
      }
      return Promise.resolve(hits);
    }
    case "scan_provenance":
      return Promise.resolve(provenance());
    case "get_settings":
      return Promise.resolve(SETTINGS);
    case "claude_check":
      return Promise.resolve({ installed: true, version: "claude 1.0.0", path: "/usr/local/bin/claude" });
    case "agent_check":
      // gemini-cli / codex-cli install probe — mock as not installed so the
      // Connections tab renders without an undefined-status crash in dev.
      return Promise.resolve({ installed: false, version: null, path: null });
    case "ollama_status":
      return Promise.resolve({ binary_installed: false, binary_path: null, version: null, daemon_running: false, endpoint: "http://localhost:11434", models: [], error: null });
    case "ollama_install_url":
      return Promise.resolve("https://ollama.com/download");
    case "git_log":
      return Promise.resolve([
        { hash: "a1b2c3d", date: "2024-03-01", subject: "ingest: transformer architecture", created: 42, modified: 6 },
        { hash: "e4f5a6b", date: "2024-02-20", subject: "ingest: scaling laws", created: 30, modified: 3 },
        { hash: "0c1d2e3", date: "2024-02-10", subject: "init: wiki bootstrap", created: 120, modified: 0 },
      ]);
    case "read_file": {
      const p = String(args.path ?? "");
      const slug = p.split("/").pop()?.replace(/\.md$/, "") ?? "";
      const d = bySlug.get(slug);
      if (d) {
        const content = `# ${d.n}\n\n${body(d)}`;
        return Promise.resolve({ path: p, raw: content, content, frontmatter: frontmatter(d) });
      }
      return Promise.resolve({ path: p, raw: "# Memex\n\nSample note.\n", content: "# Memex\n\nSample note.\n", frontmatter: null });
    }
    case "read_vault_context":
      return Promise.resolve(NODES.map((d) => `===== wiki/${d.s}.md =====\n${body(d)}`).join("\n\n"));
    case "list_provider_models":
      return Promise.resolve(["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"]);
    case "has_provider_key":
      return Promise.resolve(false);
    case "parse_links": {
      const p = String(args.path ?? "");
      const slug = p.split("/").pop()?.replace(/\.md$/, "") ?? "";
      return Promise.resolve(bySlug.get(slug)?.l ?? []);
    }
    case "write_file":
    case "set_settings":
    case "set_provider_key":
    case "delete_provider_key":
    case "open_external":
    case "delete_path":
      return Promise.resolve(null);
    case "create_file":
    case "create_folder":
    case "rename_path":
      return Promise.resolve(`${VAULT}/wiki/new.md`);
    default:
      // Unknown command (e.g. plugin event channels) — resolve benign empty.
      return Promise.resolve(undefined);
  }
}

export function installTauriMock(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args ?? {}),
    transformCallback: (cb: unknown) => cb,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    plugins: {},
  };
  // Make any leftover @tauri-apps event/webview calls no-op instead of throwing.
  console.info("[devMock] Tauri IPC mock installed with", NODES.length, "sample nodes");
}
