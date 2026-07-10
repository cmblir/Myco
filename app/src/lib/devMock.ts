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

// ?mock=1&stress=N grows the sample vault to ~N synthetic notes (community-
// structured: hubs, leaves, intra-links, sparse inter-community bridges) for
// perf work — verifying the >5k perf gate and measuring fps at 10k. DEV-only
// like the rest of this file. Deterministic: no Math.random.
function synthNodes(target: number): Node[] {
  const out: Node[] = [];
  const perComm = 40; // ~1 hub + 39 members per community
  const comms = Math.max(1, Math.ceil(target / perComm));
  for (let c = 0; c < comms; c++) {
    const hub = `stress-c${c}-hub`;
    const members: string[] = [];
    for (let m = 1; m < perComm && out.length + comms < target + comms; m++) {
      const slug = `stress-c${c}-n${m}`;
      members.push(slug);
      // Each member links its hub + a previous member (chain) → hub-and-spoke
      // with local structure, like a real wiki cluster.
      const links = [hub];
      if (m > 1) links.push(`stress-c${c}-n${m - 1}`);
      out.push({ s: slug, t: "concept", n: slug, l: links });
    }
    // Hub: links a few members + bridges to the previous two hubs.
    const hubLinks = members.slice(0, 5);
    if (c > 0) hubLinks.push(`stress-c${c - 1}-hub`);
    if (c > 1) hubLinks.push(`stress-c${c - 2}-hub`);
    out.push({ s: hub, t: "concept", n: hub, l: hubLinks });
  }
  return out;
}
{
  const stress = Number(
    new URLSearchParams(location.search).get("stress") ?? 0,
  );
  if (stress > 0) NODES.push(...synthNodes(stress));
}

const VAULT = "/Memex";
const SLUGS = new Set(NODES.map((d) => d.s));
const pathOf = (s: string): string => `${VAULT}/wiki/${s}.md`;

// ?mock=1&agent=1 flips the active query provider to an HTTP tool-capable one so
// the in-app agent loop (Feature 4) can be exercised end-to-end in the browser
// (the CLI provider tool-loops natively and isn't driven by agentLoop). Scoped
// to the flag so ordinary ?mock runs (query/study) keep the CLI provider.
const AGENT_MODE =
  new URLSearchParams(location.search).get("agent") === "1";

// Feature 3 (study) — a mutable in-memory card store so the review flow can
// grade → write → re-read and see due counts drop. Seeded with a deck of due
// cards (two scheduled in the past + one brand-new) so PageStudy has content.
const mockDecks = new Map<string, string>([
  [
    `${VAULT}/cards/transformers.md`,
    [
      "What is self-attention? ?? Each token attends to every other token in the sequence.",
      "<!--SR:!2024-01-01|2.5000|5.0000|1|0|2024-01-01|[^src-attention-is-all-you-need]-->",
      "",
      "What does multi-head attention add? ?? Several attention subspaces computed in parallel, then concatenated.",
      "<!--SR:!2024-01-01|2.5000|5.0000|1|0|2024-01-01|[[embeddings]]-->",
      "",
      "What is positional encoding for? ?? Injecting token-order information that attention alone lacks.",
      "",
    ].join("\n"),
  ],
]);
const isCardsPath = (p: string): boolean => p.startsWith(`${VAULT}/cards/`);

// Mock LLM output for study generation. claude_run is the CLI provider path; we
// branch on the prompt so card/quiz generation returns valid JSON while ordinary
// queries still get a plain answer.
function mockClaudeRun(prompt: string): { stdout: string; stderr: string; status: number } {
  const p = prompt.toLowerCase();
  let stdout: string;
  if (p.includes("flashcard")) {
    stdout = JSON.stringify([
      { front: "Mock card A?", back: "Answer A.", sourceRef: "[^src-attention-is-all-you-need]" },
      { front: "Mock card B?", back: "Answer B.", sourceRef: "[[embeddings]]" },
    ]);
  } else if (p.includes("multiple-choice")) {
    stdout = JSON.stringify([
      { question: "Mock Q1?", choices: ["Right", "Wrong 1", "Wrong 2"], answer: 0, sourceRef: "[^src-1]", explanation: "The first option is correct." },
      { question: "Mock Q2?", choices: ["Wrong", "Right"], answer: 1, sourceRef: "", explanation: "The second option is correct." },
    ]);
  } else if (p.includes("dialogue") || p.includes("two-host")) {
    stdout = JSON.stringify([
      { speaker: "A", text: "Welcome — today we dig into attention.", cites: ["[[attention-mechanism]]"] },
      { speaker: "B", text: "Right. At its core it's a weighted sum over value vectors.", cites: ["[[attention-mechanism]]"] },
      { speaker: "A", text: "And multi-head attention runs several of these in parallel.", cites: ["[[multi-head-attention]]"] },
      { speaker: "B", text: "Exactly, then concatenates the results. That's the key idea.", cites: [] },
    ]);
  } else {
    stdout = "(mock) Claude CLI reply — the real app shells `claude --print` here.";
  }
  return { stdout, stderr: "", status: 0 };
}

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
  // Demo frontmatter meta so the Phase 2 visual encoding (confidence→brightness,
  // source_count→glow, disputed→amber tint) is visible in ?mock mode.
  const lowConf = new Set([
    "interpretability",
    "planning",
    "reasoning",
    "compute-budget",
  ]);
  const disputed = new Set(["scaling-laws", "dpo"]);
  const meta: Record<
    string,
    { type: string; confidence: string; status: string; sourceCount: number }
  > = {};
  for (const d of NODES) {
    meta[pathOf(d.s)] = {
      type: d.t,
      confidence: lowConf.has(d.s)
        ? "low"
        : d.t === "entity"
          ? "medium"
          : "high",
      status: disputed.has(d.s) ? "disputed" : "active",
      sourceCount: Math.min(5, d.l.length),
    };
  }
  return { forward, backward, unresolved: {}, tags, meta };
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
  const cardsChildren = [...mockDecks.keys()].map((p) => ({
    kind: "file" as const,
    name: p.split("/").pop() ?? "deck.md",
    path: p,
  }));
  return [
    { kind: "file", name: "CLAUDE.md", path: `${VAULT}/CLAUDE.md` },
    { kind: "file", name: "welcome.md", path: `${VAULT}/welcome.md` },
    { kind: "directory", name: "audio", path: `${VAULT}/audio`, children: [] },
    { kind: "directory", name: "cards", path: `${VAULT}/cards`, children: cardsChildren },
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
  providers: { anthropic_api: false, openai_api: false, google_api: false, ollama: false, openrouter: false, memex_pro: false, builtin_local: true },
  query_provider: "anthropic-cli",
  query_model: "claude-sonnet-4-6",
  ingest_provider: "anthropic-cli",
  ingest_model: "claude-sonnet-4-6",
  memex_pro_url: "",
  memex_pro_email: "",
  auto_ingest_enabled: false,
  auto_ingest_interval_min: 60,
  auto_reflect_enabled: false,
  auto_reflect_interval_min: 180,
};

const bySlug = new Map(NODES.map((d) => [d.s, d]));

// ---- In-app agent (Feature 4) mock ----------------------------------------
const MOCK_AGENT_TOOLS = [
  { name: "search_vault", description: "Search the wiki", input_schema: { type: "object" }, write: false },
  { name: "read_page", description: "Read a page", input_schema: { type: "object" }, write: false },
  { name: "create_page", description: "Create a page", input_schema: { type: "object" }, write: true },
];

function mockAgentToolCall(_cmd: string, args: Record<string, unknown>): unknown {
  const name = String(args.name ?? "");
  const a = (args.args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "search_vault": {
      const q = String(a.query ?? "").toLowerCase();
      const hits = NODES.filter((d) => d.n.toLowerCase().includes(q) || d.s.includes(q))
        .slice(0, 5)
        .map((d) => ({ path: pathOf(d.s), name: `${d.s}.md`, line: 1, snippet: d.n }));
      return { hits: hits.length ? hits : [{ path: pathOf(NODES[0].s), name: `${NODES[0].s}.md`, line: 1, snippet: NODES[0].n }] };
    }
    case "read_page": {
      const slug = String(a.path ?? "").split("/").pop()?.replace(/\.md$/, "") ?? "";
      const d = bySlug.get(slug) ?? NODES[0];
      return { path: pathOf(d.s), content: `# ${d.n}\n\n${body(d)}` };
    }
    case "create_page":
      return { written: String(a.path ?? "wiki/new.md"), bytes: String(a.content ?? "").length };
    default:
      return { ok: true };
  }
}

// Deterministic scripted loop: first turn → call search_vault; if writes are
// offered and the task asks to write → call create_page; otherwise → final
// cited answer. Drives agentLoop through ≥1 tool step in ?mock.
function mockAgentChat(args: Record<string, unknown>): unknown {
  const req = (args.request ?? {}) as {
    messages?: { role: string }[];
    tools?: { name: string; write?: boolean }[];
  };
  const messages = req.messages ?? [];
  const tools = req.tools ?? [];
  const usage = { input_tokens: 50, output_tokens: 20 };
  const toolResults = messages.filter((m) => m.role === "tool").length;
  const userText = messages.find((m) => m.role === "user") as
    | { content?: string }
    | undefined;
  const wantsWrite = /write|create|draft|note|page/i.test(userText?.content ?? "");
  const hasWriteTool = tools.some((t) => t.name === "create_page");

  if (tools.length === 0) {
    return { text: "Partial answer at the step limit.", tool_calls: [], usage, stop: "stop" };
  }
  if (toolResults === 0) {
    return {
      text: "",
      tool_calls: [{ id: "call_1", name: "search_vault", input: { query: "attention" } }],
      usage,
      stop: "tool_use",
    };
  }
  if (toolResults === 1 && wantsWrite && hasWriteTool) {
    return {
      text: "",
      tool_calls: [
        { id: "call_2", name: "create_page", input: { path: "wiki/agent-summary.md", content: "# Summary\n\nDraft." } },
      ],
      usage,
      stop: "tool_use",
    };
  }
  return {
    text: "Based on the wiki, attention is a weighted sum over value vectors [[attention-mechanism]].",
    tool_calls: [],
    usage,
    stop: "stop",
  };
}

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
      return Promise.resolve(
        AGENT_MODE
          ? { ...SETTINGS, query_provider: "anthropic-api", query_model: "claude-sonnet-4-6" }
          : SETTINGS,
      );
    case "agent_tools_schema":
      return Promise.resolve(MOCK_AGENT_TOOLS);
    case "agent_tool_call":
      return Promise.resolve(mockAgentToolCall(cmd, args));
    case "agent_chat":
      return Promise.resolve(mockAgentChat(args));
    case "memex_pro_ingest":
      return Promise.resolve({
        summary: `(dev mock) ingested ${String(args.slug ?? "source")}`,
        applied: 2,
        paths: ["wiki/source-mock.md", "wiki/index.md"],
      });
    case "memex_pro_login":
      SETTINGS.memex_pro_email = String(args.email ?? "");
      SETTINGS.providers.memex_pro = true;
      return Promise.resolve({ email: String(args.email ?? ""), connected: true });
    case "local_classify":
      return Promise.resolve("concept");
    case "local_query":
      return Promise.resolve(
        "(mock) local model reply — the real app runs the bundled SEED 0.5B here.",
      );
    case "memex_pro_logout":
      SETTINGS.memex_pro_email = "";
      SETTINGS.providers.memex_pro = false;
      return Promise.resolve(null);
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
    case "claude_run":
      return Promise.resolve(mockClaudeRun(String(args.prompt ?? "")));
    case "read_file": {
      const p = String(args.path ?? "");
      if (isCardsPath(p)) {
        const raw = mockDecks.get(p) ?? "";
        return Promise.resolve({ path: p, raw, content: raw, frontmatter: null });
      }
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
    // Semantic layer (Feature 1) — mock the embedding index with the sample graph:
    // "similarity" stands in as a node's declared links + a couple of siblings.
    case "reindex_embeddings":
      return Promise.resolve(NODES.length);
    case "embeddings_status":
      return Promise.resolve({ indexed_pages: NODES.length, model: "builtin-local:seed" });
    case "semantic_search": {
      const q = String(args.query ?? "").toLowerCase();
      const k = Number(args.k ?? 8);
      const hits = NODES.filter(
        (d) => d.n.toLowerCase().includes(q) || body(d).toLowerCase().includes(q),
      )
        .slice(0, k)
        .map((d, i) => ({ page: `wiki/${d.s}.md`, stem: d.s, section: 0, score: 0.9 - i * 0.05 }));
      // Always return something so the UI path is exercised even on no keyword match.
      if (hits.length === 0 && NODES.length) {
        return Promise.resolve(
          NODES.slice(0, k).map((d, i) => ({ page: `wiki/${d.s}.md`, stem: d.s, section: 0, score: 0.6 - i * 0.05 })),
        );
      }
      return Promise.resolve(hits);
    }
    case "fetch_youtube_transcript":
      return Promise.resolve(
        "hello and welcome to this talk\ntoday we cover transformers and attention\n" +
          "the key idea is scaled dot-product attention\nthanks for watching",
      );
    case "semantic_edges": {
      // Emit similarity edges between nodes that are NOT already wikilinked, so
      // the overlay adds new edges (mirrors the real dedup vs the wiki graph).
      const seen = new Set<string>();
      const edges: { source: string; target: string; score: number }[] = [];
      for (let i = 0; i < NODES.length; i++) {
        const d = NODES[i];
        const linked = new Set(d.l);
        let added = 0;
        for (let j = 1; j <= NODES.length && added < 2; j++) {
          const other = NODES[(i + j * 3) % NODES.length];
          if (other.s === d.s || linked.has(other.s)) continue;
          const a = pathOf(d.s);
          const b = pathOf(other.s);
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ source: a, target: b, score: 0.75 });
          added++;
        }
      }
      return Promise.resolve(edges);
    }
    case "related_pages": {
      const page = String(args.page ?? "");
      const slug = page.split("/").pop()?.replace(/\.md$/, "") ?? "";
      const k = Number(args.k ?? 8);
      const links = bySlug.get(slug)?.l ?? [];
      return Promise.resolve(
        links.slice(0, k).map((s, i) => ({ page: `wiki/${s}.md`, stem: s, section: 0, score: 0.85 - i * 0.05 })),
      );
    }
    case "write_file": {
      const p = String(args.path ?? "");
      if (isCardsPath(p)) mockDecks.set(p, String(args.content ?? ""));
      return Promise.resolve(null);
    }
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
