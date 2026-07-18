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

// ---- event bus -------------------------------------------------------------
// Mirrors the shape @tauri-apps/api/event delivers: the handler is called with
// {event, id, payload}. Commands that emit progress in Rust emit here too, so
// the browser build exercises the same listener code paths the app does.

type MockEventHandler = (e: { event: string; id: number; payload: unknown }) => void;

const mockListeners = new Map<string, { id: number; handler: MockEventHandler }[]>();
let mockEventId = 0;

function emitMock(event: string, payload: unknown): void {
  for (const l of mockListeners.get(event) ?? []) {
    l.handler({ event, id: l.id, payload });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/// A plausible ingest transcript for the streaming CLI mock: the tool calls and
/// prose a real run emits, paced so the live panel has states to show.
const MOCK_STREAM_STEPS: { after: number; kind: string; payload: Record<string, unknown> }[] = [
  { after: 120, kind: "text", payload: { text: "Reading the source…\n" } },
  { after: 150, kind: "tool", payload: { tool: "Read", detail: "raw/source.md" } },
  { after: 150, kind: "text", payload: { text: "Extracting concepts and entities.\n" } },
  { after: 150, kind: "tool", payload: { tool: "Write", detail: "wiki/source-mock.md" } },
  { after: 150, kind: "tool", payload: { tool: "Edit", detail: "wiki/index.md" } },
  { after: 120, kind: "result", payload: { text: "done" } },
];

/// How many pages the embedding index holds. A variable, not NODES.length: the
/// difference between "indexed" and "not indexed yet" changes what several
/// features do (semantic retrieval, the Related panel, Ask's staged status) and
/// a mock that is permanently indexed can only ever show one of those. `null`
/// means "however many pages the sample vault has" — resolved late, since NODES
/// is declared below.
let mockIndexedPages: number | null = null;

// Fingerprint of the mock vault. Fixed: nothing writes to it.
const MOCK_REVISION = 0x5eed_1234;

/// Walk the sample pages the way the real reindex does, with the same events.
///
/// Paced, not instant. The real command takes ~467 ms per embedded chunk — i.e.
/// minutes on a real vault — which is the whole reason it reports progress, and
/// the reason a run routinely outlives the panel that started it. A mock that
/// finishes in a blink cannot show a test any of that: it was fast enough to
/// complete during a navigation, which is precisely the case where the run state
/// living in the component was broken. ~3s is long enough for a test to leave
/// and come back mid-run, short enough not to drag the suite.
async function mockReindex(): Promise<number> {
  emitMock("local-model-load", { loading: true, ok: false });
  await sleep(200);
  emitMock("local-model-load", { loading: false, ok: true });
  const total = NODES.length;
  for (let i = 0; i < total; i++) {
    await sleep(55);
    emitMock("reindex-progress", {
      done: i + 1,
      total,
      page: `wiki/${NODES[i].s}.md`,
      // Mirror the content-hash skip: a few pages are already up to date.
      embedded: i % 7 !== 0,
    });
  }
  return total;
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

// Feature 6 (PDF annotation) — a seeded raw PDF + a sidecar highlight so the
// viewer, highlight overlay, and click-through are exercisable in ?mock. The
// bytes are a real minimal one-page PDF (generated with a correct xref) so
// pdf.js renders it in the browser.
const MOCK_PDF_STEM = "attention-is-all-you-need";
const MOCK_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMjAwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQ2Pj4Kc3RyZWFtCkJUIC9GMSAyMCBUZiA0MCAxMjAgVGQgKEhlbGxvIE1lbWV4IFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTA1IDAwMDAwIG4gCjAwMDAwMDAyMTcgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjM3NAolJUVPRg==";
const MOCK_PDF_PATH = `${VAULT}/raw/${MOCK_PDF_STEM}.pdf`;
const MOCK_PDF_LINK_NOTE = `${VAULT}/wiki/pdf-demo.md`;
const MOCK_ANNOTATIONS_PATH = `${VAULT}/wiki/.annotations/${MOCK_PDF_STEM}.json`;
const MOCK_SIDECAR = JSON.stringify({
  source: `raw/${MOCK_PDF_STEM}.pdf`,
  anchors: [
    {
      id: "seed1",
      page: 1,
      quads: [{ x: 0.12, y: 0.42, w: 0.5, h: 0.06 }],
      text: "Hello Memex PDF",
      color: "#ffd54f",
      note: `${VAULT}/wiki/attention-mechanism.md`,
      created: "2026-07-10T00:00:00Z",
    },
  ],
});

// Feature 7 — in-memory schedules so the Schedules route + Run now work in mock.
let mockSchedules: { id: string }[] = [];

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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

// Perf harness: `?mock=1&big=N` generates a synthetic vault of ~N nodes spread
// across a dozen folders with a power-law-ish link structure, so the cosmic
// graph can be profiled at real scale (the curated NODES set is ~57). Purely a
// dev affordance — gated on the URL param, never reached in a packaged build.
function bigCount(): number {
  if (typeof window === "undefined") return 0;
  const v = new URLSearchParams(window.location.search).get("big");
  if (v == null) return 0;
  return Math.min(20000, Math.max(0, parseInt(v, 10) || 3000));
}
function bigRand(n: number): number {
  let x = (n * 1664525 + 1013904223) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
const BIG_FOLDERS = [
  "neural-networks", "data-science", "keyboard-hobby", "spain-tech",
  "deep-learning", "alignment", "distillation", "rag", "quantization",
  "activation", "topics", "misc",
];
// `?big=N&skew=1` reproduces the real-vault shape: ONE dominant folder (~90%)
// with a handful of small ones — a single giant galaxy, which stresses the
// node-sprite overdraw and LOD far harder than the even 12-folder spread.
function bigSkew(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("skew") === "1";
}
export function bigPath(i: number): string {
  if (bigSkew()) {
    // 90% in folder 0, the rest sprinkled across the next 5.
    const f = bigRand(i * 7 + 3) < 0.9 ? BIG_FOLDERS[0] : BIG_FOLDERS[1 + (i % 5)];
    return `${VAULT}/${f}/note-${i}.md`;
  }
  return `${VAULT}/${BIG_FOLDERS[i % BIG_FOLDERS.length]}/note-${i}.md`;
}
function buildBigAdjacency(n: number) {
  const forward: Record<string, string[]> = {};
  const backward: Record<string, string[]> = {};
  const tags: Record<string, string[]> = {};
  // A handful of hubs per folder; most notes link to a hub + a couple of peers.
  for (let i = 0; i < n; i++) {
    const src = bigPath(i);
    tags[src] = ["concept"];
    const links: string[] = [];
    const folderStart = i - (i % 12); // rough hub within the same slice
    const hub = folderStart + (folderStart % 7); // deterministic hub target
    if (hub !== i && hub < n) links.push(bigPath(hub));
    const peers = 1 + Math.floor(bigRand(i) * 3);
    for (let k = 0; k < peers; k++) {
      const t = Math.floor(bigRand(i * 31 + k) * n);
      if (t !== i) links.push(bigPath(t));
    }
    if (links.length) {
      forward[src] = links;
      for (const t of links) (backward[t] ||= []).push(src);
    }
  }
  return { forward, backward, unresolved: {}, tags, meta: {} };
}

// Re-key every path id in an adjacency from `${VAULT}/...` to `${root}/...`,
// so the multiverse mock can hand each universe a distinct node namespace.
function rerootAdjacency(
  adj: ReturnType<typeof buildAdjacency>,
  root: string,
): ReturnType<typeof buildAdjacency> {
  const re = (p: string): string => (p.startsWith(VAULT) ? root + p.slice(VAULT.length) : p);
  const remapMap = (m: Record<string, string[]>): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [k, arr] of Object.entries(m)) out[re(k)] = arr.map(re);
    return out;
  };
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(adj.meta ?? {})) meta[re(k)] = v;
  return {
    forward: remapMap(adj.forward),
    backward: remapMap(adj.backward),
    unresolved: remapMap(adj.unresolved ?? {}),
    tags: remapMap(adj.tags),
    meta: meta as typeof adj.meta,
  };
}

function buildAdjacency() {
  const big = bigCount();
  if (big > 0) return buildBigAdjacency(big);
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
  // Perf harness: mirror the synthetic big vault as a flat folder set so the
  // graph builder sees every generated note.
  const big = bigCount();
  if (big > 0) {
    const byFolder = new Map<string, { kind: "file"; name: string; path: string }[]>();
    for (let i = 0; i < big; i++) {
      const p = bigPath(i);
      const folder = p.slice(0, p.lastIndexOf("/"));
      (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push({
        kind: "file",
        name: p.split("/").pop()!,
        path: p,
      });
    }
    return [...byFolder.entries()].map(([path, children]) => ({
      kind: "directory" as const,
      name: path.split("/").pop()!,
      path,
      children,
    }));
  }
  const wikiChildren = [
    { kind: "file", name: "index.md", path: `${VAULT}/wiki/index.md` },
    { kind: "file", name: "log.md", path: `${VAULT}/wiki/log.md` },
    { kind: "file", name: "pdf-demo.md", path: MOCK_PDF_LINK_NOTE },
    ...NODES.map((d) => ({ kind: "file", name: `${d.s}.md`, path: pathOf(d.s) })),
  ];
  const cardsChildren = [...mockDecks.keys()].map((p) => ({
    kind: "file" as const,
    name: p.split("/").pop() ?? "deck.md",
    path: p,
  }));
  const inboxChildren = [...mockInbox.keys()].map((p) => ({
    kind: "file" as const,
    name: p.split("/").pop() ?? "clip.md",
    path: p,
  }));
  return [
    { kind: "file", name: "CLAUDE.md", path: `${VAULT}/CLAUDE.md` },
    { kind: "file", name: "welcome.md", path: `${VAULT}/welcome.md` },
    // Only when it has something in it, like the real scaffold's _inbox/.
    ...(inboxChildren.length
      ? [{ kind: "directory" as const, name: "_inbox", path: `${VAULT}/_inbox`, children: inboxChildren }]
      : []),
    { kind: "directory", name: "audio", path: `${VAULT}/audio`, children: [] },
    { kind: "directory", name: "cards", path: `${VAULT}/cards`, children: cardsChildren },
    { kind: "directory", name: "daily", path: `${VAULT}/daily`, children: [] },
    {
      kind: "directory",
      name: "ingest-reports",
      path: `${VAULT}/ingest-reports`,
      // One report so the History page renders a row (it was empty, which made
      // History untestable and hid the row's a11y structure).
      children: [
        {
          kind: "file" as const,
          name: "2026-07-15-attention.md",
          path: `${VAULT}/ingest-reports/2026-07-15-attention.md`,
        },
      ],
    },
    { kind: "directory", name: "raw", path: `${VAULT}/raw`, children: [
      { kind: "file", name: `${MOCK_PDF_STEM}.pdf`, path: MOCK_PDF_PATH },
    ] },
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
  auto_reindex_enabled: false,
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
    // The vault fingerprint. Constant here because the mock vault is in-memory
    // and never changes on disk — which is exactly right: it makes the poll's
    // steady state (revision unmoved -> skip the rebuild) the path a mock run
    // exercises.
    case "vault_revision":
      return Promise.resolve(MOCK_REVISION);
    // Multiverse (Phase 0): a two-universe registry. Both slugs reuse the one
    // mock vault graph; per-slug graph variation comes with the Phase 1 UI.
    case "list_projects":
      return Promise.resolve([
        {
          slug: "karpathy-llm",
          title: "Karpathy LLM Wiki",
          description: "LLM knowledge wiki",
          root: `${VAULT}/projects/karpathy-llm`,
          noteCount: NODES.length,
          created: "2026-07-06",
          lastUsed: "2026-07-16",
          independentVault: true,
          active: true,
        },
        {
          slug: "reading-log",
          title: "Reading Log",
          description: "Books and papers",
          root: `${VAULT}/projects/reading-log`,
          noteCount: 12,
          created: "2026-07-10",
          lastUsed: "2026-07-12",
          independentVault: false,
          active: false,
        },
      ]);
    case "build_link_graph_at":
      // Re-root the demo graph under the requested project so each universe has
      // DISTINCT node ids (real backends return per-project absolute paths). A
      // single shared graph would collapse to one universe in the merge.
      return Promise.resolve(
        rerootAdjacency(buildAdjacency(), `${VAULT}/projects/${String(args.slug ?? "x")}`),
      );
    // Multiverse (universes = registry projects UNION sibling vaults). The mock
    // presents two sibling vaults beside the open one to exercise the flow.
    case "list_universes":
      return Promise.resolve([
        {
          slug: "Memex",
          title: "Memex",
          description: "",
          root: VAULT,
          noteCount: NODES.length,
          created: "",
          lastUsed: "",
          independentVault: false,
          active: true,
        },
        {
          slug: "memex-demo-10k",
          title: "memex-demo-10k",
          description: "",
          root: `${VAULT}/../memex-demo-10k`,
          noteCount: 42,
          created: "",
          lastUsed: "",
          independentVault: false,
          active: false,
        },
        {
          slug: "Obsidian Vault",
          title: "Obsidian Vault",
          description: "",
          root: `${VAULT}/../Obsidian Vault`,
          noteCount: 18,
          created: "",
          lastUsed: "",
          independentVault: true,
          active: false,
        },
      ]);
    case "build_universe_graph":
      return Promise.resolve(rerootAdjacency(buildAdjacency(), String(args.root ?? "x")));
    case "set_active_project":
      return Promise.resolve({
        path: `${VAULT}/projects/${String(args.slug ?? "")}`,
        name: String(args.slug ?? ""),
      });
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
    case "list_schedules":
      return Promise.resolve(mockSchedules);
    case "upsert_schedule": {
      const s = args.schedule as { id: string };
      const i = mockSchedules.findIndex((x) => x.id === s.id);
      if (i >= 0) mockSchedules[i] = s;
      else mockSchedules.push(s);
      return Promise.resolve([...mockSchedules]);
    }
    case "delete_schedule": {
      const id = String(args.id ?? "");
      mockSchedules = mockSchedules.filter((x) => x.id !== id);
      return Promise.resolve([...mockSchedules]);
    }
    case "install_background_schedule":
      return Promise.resolve(
        args.on
          ? "(mock) background schedule installed"
          : "(mock) background schedule removed",
      );
    case "get_settings":
      return Promise.resolve(
        AGENT_MODE
          ? { ...SETTINGS, query_provider: "anthropic-api", query_model: "claude-sonnet-4-6" }
          : { ...SETTINGS },
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
      // Paced, like the real thing. Measured: prefill dominates a local answer
      // (~0.67 ms/token, ~2.7 s over a full context) and a cold weight load adds
      // up to 11.7 s. A mock that answers instantly means no test — and no
      // developer — ever sees the wait states that exist because of those
      // numbers.
      return sleep(700).then(
        () => "(mock) local model reply — the real app runs the bundled Gemma 3 1B here.",
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
    // The streaming CLI run. Missing until now, which meant `res` came back
    // undefined and every ingest and lint in ?mock=1 died on `res.status` with
    // a TypeError that looked like an app bug — so the whole ingest flow, the
    // app's headline feature, was untestable in the mock the E2E suites use.
    // Emits a plausible claude-stream transcript so the mission-control panel
    // has something to render, then returns the same result claude_run does.
    case "claude_run_stream": {
      const runId = String(args.runId ?? args.run_id ?? "");
      const emit = (kind: string, extra: Record<string, unknown>) =>
        emitMock("claude-stream", { run_id: runId, kind, tool: null, detail: null, text: null, ...extra });
      void (async () => {
        emit("init", {});
        for (const step of MOCK_STREAM_STEPS) {
          await sleep(step.after);
          emit(step.kind, step.payload);
        }
      })();
      return Promise.resolve(mockClaudeRun(String(args.prompt ?? "")));
    }
    case "read_raw_bytes":
      // Serve the seeded PDF bytes for any raw/*.pdf (real Rust confines to raw/).
      return Promise.resolve(b64ToBytes(MOCK_PDF_B64).buffer);
    case "read_file": {
      const p = String(args.path ?? "");
      if (p.includes("/ingest-reports/")) {
        const raw =
          "# Ingest report — attention\n\nAdded 3 facts, merged 1, cited 2 sources.\n";
        return Promise.resolve({ path: p, raw, content: raw, frontmatter: null });
      }
      // A clip waiting in _inbox/ — auto-ingest reads it before ingesting.
      const clip = mockInbox.get(p);
      if (clip !== undefined) {
        return Promise.resolve({ path: p, raw: clip, content: clip, frontmatter: null });
      }
      if (isCardsPath(p)) {
        const raw = mockDecks.get(p) ?? "";
        return Promise.resolve({ path: p, raw, content: raw, frontmatter: null });
      }
      if (p === MOCK_ANNOTATIONS_PATH) {
        return Promise.resolve({ path: p, raw: MOCK_SIDECAR, content: MOCK_SIDECAR, frontmatter: null });
      }
      if (p === MOCK_PDF_LINK_NOTE) {
        const body =
          `# PDF demo\n\nSee the source: [[pdf::${MOCK_PDF_STEM}#p1:seed1|Hello Memex PDF]].\n`;
        return Promise.resolve({ path: p, raw: body, content: body, frontmatter: null });
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
    // Semantic layer (Feature 1) — mock the embedding index with the sample graph:
    // "similarity" stands in as a node's declared links + a couple of siblings.
    case "reindex_embeddings":
      return mockReindex();
    case "embeddings_status":
      return Promise.resolve({
        indexed_pages: mockIndexedPages ?? NODES.length,
        model: "builtin-local:seed",
      });
    // Retrieval costs a query embedding against the real model (~460 ms for a
    // chunk-sized text), so it is not free here either.
    case "semantic_search": {
      const q = String(args.query ?? "").toLowerCase();
      const k = Number(args.k ?? 8);
      const hits = NODES.filter(
        (d) => d.n.toLowerCase().includes(q) || body(d).toLowerCase().includes(q),
      )
        .slice(0, k)
        .map((d, i) => ({ page: `wiki/${d.s}.md`, stem: d.s, section: 0, score: 0.9 - i * 0.05 }));
      // Always return something so the UI path is exercised even on no keyword match.
      const out = hits.length === 0 && NODES.length
        ? NODES.slice(0, k).map((d, i) => ({ page: `wiki/${d.s}.md`, stem: d.s, section: 0, score: 0.6 - i * 0.05 }))
        : hits;
      return sleep(400).then(() => out);
    }
    case "describe_image":
      return Promise.resolve(
        "(mock) Image description: a labeled diagram of the transformer architecture — " +
          "encoder/decoder stacks, multi-head attention blocks, and positional encodings.",
      );
    case "whisper_check":
      return Promise.resolve({ installed: true, version: "whisper 1.0", path: "/usr/local/bin/whisper" });
    case "transcribe_media":
      return Promise.resolve(
        "(mock) Transcript: today we cover attention and how scaled dot-product attention works.",
      );
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
    case "delete_path":
      // Consuming an inbox source removes it, which is how auto-ingest avoids
      // ingesting the same clip forever.
      mockInbox.delete(String(args.path ?? ""));
      return Promise.resolve(null);
    case "archive_inbox_source": {
      // Same effect on the inbox as delete_path — the source leaves the tray —
      // but it moves to .archived/ instead of vanishing.
      const p = String(args.path ?? "");
      mockInbox.delete(p);
      const name = p.split("/").pop() ?? "source.md";
      return Promise.resolve(`${VAULT}/_inbox/.archived/${name}`);
    }
    case "set_settings":
      // Actually persist. Returning null and keeping a frozen SETTINGS made the
      // mock silently ignore every settings change — so a flow that depends on
      // one (Ask via the builtin model rather than the CLI, say) could not be
      // exercised at all, and a test that tried looked like the FEATURE was
      // broken.
      Object.assign(SETTINGS, args.settings ?? {});
      return Promise.resolve(null);
    case "set_provider_key":
    case "delete_provider_key":
    case "open_external":
      return Promise.resolve(null);
    case "create_file":
    case "create_folder":
    case "rename_path":
      return Promise.resolve(`${VAULT}/wiki/new.md`);
    // ---- event bus -------------------------------------------------------
    // @tauri-apps/api/event's listen()/unlisten() are themselves invokes, so
    // the mock has to answer them or every listener in the app silently never
    // fires — and the returned unlisten resolves to nothing, which is where the
    // stray rejection in a plain-browser run came from.
    case "plugin:event|listen": {
      const name = String(args.event ?? "");
      const handler = args.handler as MockEventHandler | undefined;
      if (typeof handler !== "function") return Promise.resolve(0);
      const id = ++mockEventId;
      const list = mockListeners.get(name) ?? [];
      list.push({ id, handler });
      mockListeners.set(name, list);
      return Promise.resolve(id);
    }
    case "plugin:event|unlisten": {
      const name = String(args.event ?? "");
      const id = Number(args.eventId);
      const list = mockListeners.get(name);
      if (list) mockListeners.set(name, list.filter((l) => l.id !== id));
      return Promise.resolve(undefined);
    }
    // The rest of the registered surface. Nothing here is interesting to look
    // at — the point is that it EXISTS, so the default below can reject like
    // the real thing.
    case "write_run_log":
      return Promise.resolve(null);
    case "claude_cancel":
      return Promise.resolve(true);
    case "read_external_text":
      return Promise.resolve("(mock) text extracted from the dropped file.");
    case "scaffold_obsidian_vault":
      return Promise.resolve(`${VAULT}/.obsidian`);
    case "agent_run":
      return Promise.resolve(mockClaudeRun(String(args.prompt ?? "")));
    case "chat_complete": {
      const req = (args.request ?? {}) as { provider_id?: string; model?: string };
      return Promise.resolve({
        provider_id: req.provider_id ?? "anthropic-api",
        model: req.model ?? "mock-model",
        content: "(mock) provider reply — the real app calls the HTTP provider here.",
        usage: { input_tokens: 120, output_tokens: 42 },
      });
    }
    case "mcp_registration_info":
      return Promise.resolve({
        found: true,
        installed: false,
        serving: false,
        url: "http://localhost:22360/sse",
        python: "/usr/bin/python3",
        script: "/mock/memex_mcp.py",
        command: "claude mcp add --transport sse memex http://localhost:22360/sse",
        desktop_json: null,
      });
    case "mcp_install":
      return Promise.resolve("(mock) MCP server installed.");
    case "mcp_register":
      return Promise.resolve("(mock) registered with the Claude CLI.");
    case "mcp_serve":
      return Promise.resolve("(mock) MCP server started.");
    case "mcp_stop":
      return Promise.resolve("(mock) MCP server stopped.");
    default:
      // Reject, like the real Tauri does for a command that is not registered.
      // Resolving `undefined` instead is how the mock hid a broken feature for
      // as long as it did: ingest called claude_run_stream, got undefined back,
      // and died on `res.status` with a TypeError that read like an app bug —
      // in the mock every E2E suite runs against. A command that reaches here
      // is either a typo or an unmocked command, and both should be loud.
      return Promise.reject(
        new Error(`devMock: no handler for command "${cmd}" — add one in devMock.ts`),
      );
  }
}

/// Sources waiting in `_inbox/`, keyed by path. The clipper drops files here and
/// auto-ingest consumes them, so the mock has to model it as state rather than a
/// fixed listing — otherwise `runInboxPass` always finds an empty inbox and the
/// whole handoff is untestable.
const mockInbox = new Map<string, string>();

/// Drop a clip into `_inbox/` and fire the deep-link handler's
/// `memex://clip-saved`, the same path the real Tauri event takes into the app.
/// Exported for the clip E2E: a deep link cannot be delivered to a browser.
export function emitClipSaved(title = "clipped-article"): void {
  mockInbox.set(
    `${VAULT}/_inbox/${title}.md`,
    `---\nsource_url: https://example.com/article\n---\n\n# ${title}\n\nClipped selection about attention and transformers.\n`,
  );
  emitMock("memex://clip-saved", {});
}

export function installTauriMock(): void {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
  };
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args ?? {}),
    // The real Tauri registers the callback and hands back an id; the mock
    // passes the function through, and `plugin:event|listen` above stores it.
    transformCallback: (cb: unknown) => cb,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    plugins: {},
  };
  // @tauri-apps/api's _unlisten() reaches for this global directly rather than
  // going through invoke(), so leaving it undefined made every unlisten throw
  // "Cannot read properties of undefined (reading 'unregisterListener')" — an
  // unhandled rejection from any component that cleans up a listener, which is
  // all of them. That noise was being read as an app bug; it is only ever the
  // mock being incomplete.
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) => {
      const list = mockListeners.get(event);
      if (list) mockListeners.set(event, list.filter((l) => l.id !== eventId));
    },
  };
  // Test surface for the mock itself. Exposed from HERE, inside the module the
  // app actually loaded: a Playwright `evaluate` that dynamic-imports this file
  // gets a SECOND module instance with its own empty listener registry, so
  // anything it emits reaches nobody.
  (
    window as unknown as { __memexMock?: unknown }
  ).__memexMock = {
    emit: emitMock,
    clip: emitClipSaved,
    inbox: () => [...mockInbox.keys()],
    /// Patch the mock's settings. The Settings UI cannot reach every
    /// combination — its provider picker only lists ENABLED providers, so a
    /// vault configured for the CLI cannot be switched to the builtin model
    /// through the UI at all, and a flow that only runs on the non-tool path
    /// (Ask's staged status) is otherwise unreachable from a test.
    settings: (patch: Record<string, unknown>) => Object.assign(SETTINGS, patch),
    /// Pretend the index holds `n` pages (0 = never built).
    indexedPages: (n: number) => {
      mockIndexedPages = n;
    },
  };
  console.info("[devMock] Tauri IPC mock installed with", NODES.length, "sample nodes");
}
