// DEV-ONLY Tauri IPC mock. Lets the React UI run in a plain browser (vite dev)
// with a large sample vault, so screenshots / visual QA can be captured with
// Playwright without the native shell. Activated only when:
//   import.meta.env.DEV === true  AND  the URL has ?mock=1
// so it is dead-code-eliminated from production bundles (the dmg never ships it).
//
// It installs window.__TAURI_INTERNALS__.invoke with an in-memory implementation
// backed by the same sample-graph topology the Rust seed uses, so the Graph,
// Overview, Provenance and Reader views render real-looking content.

import type { BucketUsage, DistillConfig } from "./distill";
import type { QuarantineItem } from "./quarantine";
import type {
  HitTier,
  ScoredChunk,
  SemanticSearchResult,
  TierWeights,
  AudioOverviewDraft,
  AudioOverviewJobContext,
  AudioOverviewPublication,
  StudyDeckContext,
} from "./ipc";
import { DEFAULT_TIER_WEIGHTS, hitTier, sourceTier } from "./extractive";
import { serializeDeck } from "./cards";
import { BLANK, cardsFromNote } from "./extractiveCards";
import { STRINGS } from "./i18n";
import { today } from "./taskLine";
import { appendCapture } from "./dailyNote";
import { loadDayLinks, saveDayLinks, snapshot } from "./dayConnections";
import { getValue, parseFrontmatter } from "./frontmatter";
import { sha256 } from "./tidyRun";
import { BUILTIN_CHAT_MODEL } from "./providers";

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

type MockEventHandler = (e: {
  event: string;
  id: number;
  payload: unknown;
}) => void;

const mockListeners = new Map<
  string,
  { id: number; handler: MockEventHandler }[]
>();
let mockEventId = 0;

function emitMock(event: string, payload: unknown): void {
  for (const l of mockListeners.get(event) ?? []) {
    l.handler({ event, id: l.id, payload });
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/// A plausible ingest transcript for the streaming CLI mock: the tool calls and
/// prose a real run emits, paced so the live panel has states to show.
const MOCK_STREAM_STEPS: {
  after: number;
  kind: string;
  payload: Record<string, unknown>;
}[] = [
  { after: 120, kind: "text", payload: { text: "Reading the source…\n" } },
  {
    after: 150,
    kind: "tool",
    payload: { tool: "Read", detail: "raw/source.md" },
  },
  {
    after: 150,
    kind: "text",
    payload: { text: "Extracting concepts and entities.\n" },
  },
  {
    after: 150,
    kind: "tool",
    payload: { tool: "Write", detail: "wiki/source-mock.md" },
  },
  {
    after: 150,
    kind: "tool",
    payload: { tool: "Edit", detail: "wiki/index.md" },
  },
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

/** One `?mock=1&<name>=…` query flag. Guarded because this module is imported
 * by unit tests too, where there is no `location` at all — a bare
 * `location.search` at module scope made the whole file unimportable outside a
 * browser. */
function mockParam(name: string): string | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get(name);
}

// ?mock=1&slow=1 stretches the paced mocks (reindex, distill) far enough to
// inspect mid-run UI by hand — the Topbar activity chip/popover in particular.
const MOCK_SLOW = mockParam("slow") === "1";

// ?mock=1&quiet=1 is a vault with nothing to report: no pages to check, no
// runs, no disputed pages — Home's notices bell with no badge.
const MOCK_QUIET = mockParam("quiet") === "1";

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
    await sleep(MOCK_SLOW ? 500 : 55);
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

// A paced bulk-import sweep: emit throttled import-progress (like the real Rust
// engine) then resolve with an outcome that includes failures, so the progress
// bar, running tally, failures list and retry button are all exercisable.
async function mockImportSweep(source: string): Promise<unknown> {
  const total = 14;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < total; i++) {
    await sleep(60);
    // A couple of files "fail"; most import, some are already-seen skips.
    if (i === 5 || i === 11) failed++;
    else if (i % 3 === 0) skipped++;
    else imported++;
    emitMock("import-progress", {
      done: i + 1,
      total,
      file: `session-${i}.jsonl`,
      imported,
      skipped,
      failed,
    });
  }
  return {
    source,
    imported,
    skipped,
    quarantined: [],
    failed: [
      {
        path: "/Users/you/.claude/projects/x/live.jsonl",
        error: "cannot read: mid-write",
      },
      {
        path: "/Users/you/.claude/projects/y/truncated.jsonl",
        error: "cannot read: unexpected EOF",
      },
    ],
  };
}

// Same topology as src-tauri/src/sample_vault.rs (kept in sync as demo data).
const NODES: Node[] = [
  {
    s: "transformer-architecture",
    t: "concept",
    n: "Transformer Architecture",
    l: [
      "attention-mechanism",
      "embeddings",
      "tokenization",
      "positional-encoding",
      "residual-connections",
      "feedforward-network",
      "scaling-laws",
      "source-attention-is-all-you-need",
    ],
  },
  {
    s: "attention-mechanism",
    t: "technique",
    n: "Attention Mechanism",
    l: [
      "transformer-architecture",
      "self-attention",
      "multi-head-attention",
      "embeddings",
      "kv-cache",
      "source-attention-is-all-you-need",
    ],
  },
  {
    s: "self-attention",
    t: "technique",
    n: "Self-Attention",
    l: ["attention-mechanism", "multi-head-attention"],
  },
  {
    s: "multi-head-attention",
    t: "technique",
    n: "Multi-Head Attention",
    l: ["attention-mechanism", "self-attention"],
  },
  {
    s: "embeddings",
    t: "concept",
    n: "Embeddings",
    l: [
      "transformer-architecture",
      "tokenization",
      "attention-mechanism",
      "vector-database",
    ],
  },
  {
    s: "tokenization",
    t: "technique",
    n: "Tokenization",
    l: ["embeddings", "byte-pair-encoding", "transformer-architecture"],
  },
  {
    s: "byte-pair-encoding",
    t: "technique",
    n: "Byte-Pair Encoding",
    l: ["tokenization"],
  },
  {
    s: "positional-encoding",
    t: "technique",
    n: "Positional Encoding",
    l: ["transformer-architecture", "attention-mechanism"],
  },
  {
    s: "residual-connections",
    t: "concept",
    n: "Residual Connections",
    l: ["transformer-architecture", "layer-normalization"],
  },
  {
    s: "layer-normalization",
    t: "technique",
    n: "Layer Normalization",
    l: ["transformer-architecture", "residual-connections"],
  },
  {
    s: "feedforward-network",
    t: "concept",
    n: "Feedforward Network",
    l: ["transformer-architecture"],
  },
  {
    s: "scaling-laws",
    t: "concept",
    n: "Scaling Laws",
    l: [
      "transformer-architecture",
      "pretraining",
      "compute-budget",
      "source-scaling-laws-paper",
      "analysis-scaling-vs-data",
    ],
  },
  {
    s: "pretraining",
    t: "technique",
    n: "Pretraining",
    l: ["scaling-laws", "fine-tuning", "transformer-architecture"],
  },
  {
    s: "compute-budget",
    t: "concept",
    n: "Compute Budget",
    l: ["scaling-laws", "quantization"],
  },
  {
    s: "fine-tuning",
    t: "technique",
    n: "Fine-tuning",
    l: ["pretraining", "instruction-tuning", "rlhf", "lora"],
  },
  {
    s: "instruction-tuning",
    t: "technique",
    n: "Instruction Tuning",
    l: ["fine-tuning", "rlhf"],
  },
  {
    s: "rlhf",
    t: "technique",
    n: "RLHF",
    l: [
      "fine-tuning",
      "dpo",
      "reward-modeling",
      "alignment",
      "anthropic",
      "openai",
    ],
  },
  {
    s: "dpo",
    t: "technique",
    n: "Direct Preference Optimization",
    l: ["rlhf", "alignment", "analysis-rlhf-vs-dpo"],
  },
  {
    s: "reward-modeling",
    t: "concept",
    n: "Reward Modeling",
    l: ["rlhf", "alignment"],
  },
  { s: "lora", t: "technique", n: "LoRA", l: ["fine-tuning", "quantization"] },
  {
    s: "quantization",
    t: "technique",
    n: "Quantization",
    l: ["lora", "distillation", "inference-optimization", "compute-budget"],
  },
  {
    s: "distillation",
    t: "technique",
    n: "Knowledge Distillation",
    l: ["quantization", "fine-tuning"],
  },
  {
    s: "inference-optimization",
    t: "concept",
    n: "Inference Optimization",
    l: ["quantization", "kv-cache"],
  },
  {
    s: "kv-cache",
    t: "technique",
    n: "KV Cache",
    l: ["inference-optimization", "attention-mechanism"],
  },
  {
    s: "alignment",
    t: "concept",
    n: "Alignment",
    l: [
      "rlhf",
      "constitutional-ai",
      "interpretability",
      "reward-modeling",
      "anthropic",
    ],
  },
  {
    s: "constitutional-ai",
    t: "technique",
    n: "Constitutional AI",
    l: ["alignment", "anthropic", "rlhf", "source-constitutional-ai-paper"],
  },
  {
    s: "interpretability",
    t: "concept",
    n: "Interpretability",
    l: ["alignment", "anthropic"],
  },
  {
    s: "in-context-learning",
    t: "concept",
    n: "In-Context Learning",
    l: ["transformer-architecture", "chain-of-thought", "prompting"],
  },
  {
    s: "chain-of-thought",
    t: "technique",
    n: "Chain-of-Thought",
    l: ["in-context-learning", "prompting", "reasoning"],
  },
  {
    s: "prompting",
    t: "technique",
    n: "Prompting",
    l: ["in-context-learning", "chain-of-thought", "rag"],
  },
  {
    s: "rag",
    t: "technique",
    n: "Retrieval-Augmented Generation",
    l: ["embeddings", "vector-database", "prompting", "tool-use"],
  },
  {
    s: "vector-database",
    t: "concept",
    n: "Vector Database",
    l: ["rag", "embeddings"],
  },
  {
    s: "tool-use",
    t: "technique",
    n: "Tool Use",
    l: ["agents", "function-calling", "rag", "mcp"],
  },
  {
    s: "function-calling",
    t: "technique",
    n: "Function Calling",
    l: ["tool-use", "agents"],
  },
  {
    s: "agents",
    t: "concept",
    n: "Agents",
    l: ["tool-use", "mcp", "chain-of-thought", "planning", "reasoning"],
  },
  {
    s: "mcp",
    t: "concept",
    n: "Model Context Protocol",
    l: ["tool-use", "agents", "anthropic"],
  },
  { s: "planning", t: "concept", n: "Planning", l: ["agents", "reasoning"] },
  {
    s: "reasoning",
    t: "concept",
    n: "Reasoning",
    l: ["chain-of-thought", "planning", "agents"],
  },
  {
    s: "openai",
    t: "entity",
    n: "OpenAI",
    l: ["gpt-4", "scaling-laws", "rlhf"],
  },
  {
    s: "anthropic",
    t: "entity",
    n: "Anthropic",
    l: ["claude", "constitutional-ai", "alignment", "mcp", "rlhf"],
  },
  {
    s: "google-deepmind",
    t: "entity",
    n: "Google DeepMind",
    l: ["gemini", "transformer-architecture", "attention-mechanism"],
  },
  { s: "meta-ai", t: "entity", n: "Meta AI", l: ["llama", "lora"] },
  {
    s: "gpt-4",
    t: "entity",
    n: "GPT-4",
    l: ["openai", "transformer-architecture", "rlhf"],
  },
  {
    s: "claude",
    t: "entity",
    n: "Claude",
    l: ["anthropic", "constitutional-ai", "mcp"],
  },
  {
    s: "gemini",
    t: "entity",
    n: "Gemini",
    l: ["google-deepmind", "transformer-architecture"],
  },
  {
    s: "llama",
    t: "entity",
    n: "Llama",
    l: ["meta-ai", "fine-tuning", "lora"],
  },
  {
    s: "source-attention-is-all-you-need",
    t: "source-summary",
    n: "Source: Attention Is All You Need",
    l: ["transformer-architecture", "attention-mechanism"],
  },
  {
    s: "source-scaling-laws-paper",
    t: "source-summary",
    n: "Source: Scaling Laws for Neural Language Models",
    l: ["scaling-laws", "pretraining"],
  },
  {
    s: "source-constitutional-ai-paper",
    t: "source-summary",
    n: "Source: Constitutional AI",
    l: ["constitutional-ai", "anthropic"],
  },
  {
    s: "analysis-scaling-vs-data",
    t: "analysis",
    n: "Scaling vs. Data Quality",
    l: ["scaling-laws", "pretraining", "transformer-architecture"],
  },
  {
    s: "analysis-rlhf-vs-dpo",
    t: "analysis",
    n: "RLHF vs. DPO",
    l: ["rlhf", "dpo", "alignment"],
  },
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
  const stress = Number(mockParam("stress") ?? 0);
  if (stress > 0) NODES.push(...synthNodes(stress));
}

const VAULT = "/myco";
let mockOpeningToken = 1;
let mockVaultOpen = true;
// Synthetic browser checkpoints only; these maps do not survive process exit.
const mockEditorBaselines = new Map<string, string>();
interface MockEditorDraft {
  path: string;
  baselineRaw: string;
  baselineRevision: string;
  draftRaw: string;
  revision: string;
  origin: { vaultPath: string; openingToken: string };
  mockOnly: true;
}
const mockEditorDrafts = new Map<string, MockEditorDraft>();
let mockEditorDraftRevision = 0;
// Explicit UI fixtures only: no native grant, inference, process drain, or disk
// receipt is established by these in-memory Audio command lookalikes.
const mockAudioJobs = new Map<string, {
  context: AudioOverviewJobContext;
  title: string;
  pages: string[];
  dateIso: string;
  cancelled: boolean;
  draft?: AudioOverviewDraft;
  publication?: AudioOverviewPublication;
}>();
let mockAudioJobId = 0;
// Browser-demo baselines only: this map proves no native file/directory identity.
const mockStudyDeckSnapshots = new Map<string, {
  context: StudyDeckContext;
  raw: string | null;
}>();
let mockStudyDeckSnapshotId = 0;
const MAX_MOCK_STUDY_BYTES = 1024 * 1024;

function assertMockStudyOpening(origin: StudyDeckContext["origin"]): void {
  if (!mockVaultOpen || origin?.vaultPath !== VAULT || origin.openingToken !== String(mockOpeningToken)) {
    throw new Error("MOCK_STUDY_STALE_OPENING: browser demo opening changed");
  }
}

function assertMockStudyPath(path: string): void {
  const name = path.startsWith(`${VAULT}/cards/`) ? path.slice(`${VAULT}/cards/`.length) : "";
  const hasControl = Array.from(name).some((character) => {
    const scalar = character.codePointAt(0) ?? 0;
    return scalar < 32 || scalar === 127;
  });
  if (!name || name.startsWith(".") || /[/\\]/.test(name) || hasControl || !/\.md$/i.test(name)) {
    throw new Error("MOCK_STUDY_PATH_REFUSED: only direct demo cards/*.md files are allowed");
  }
}

function mockStudyBaseline(context: StudyDeckContext) {
  const baseline = context && mockStudyDeckSnapshots.get(context.snapshotId);
  if (!baseline || context.path !== baseline.context.path ||
    context.origin?.vaultPath !== baseline.context.origin.vaultPath ||
    context.origin.openingToken !== baseline.context.origin.openingToken) {
    throw new Error("MOCK_STUDY_SNAPSHOT_REFUSED: an exact issued demo snapshot is required");
  }
  return baseline;
}
const SLUGS = new Set(NODES.map((d) => d.s));
const pathOf = (s: string): string => `${VAULT}/wiki/${s}.md`;

/** Match the native root/raw guard after resolving virtual dot components. */
function protectedMutation(path: string, isDestination = false): Error | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const canonical = `/${parts.join("/")}`;
  if (canonical === VAULT && !isDestination) return new Error("refused: the open vault root cannot be mutated");
  if (canonical === `${VAULT}/raw` || canonical.startsWith(`${VAULT}/raw/`)) {
    return new Error("refused: raw/ is immutable");
  }
  return null;
}

const MOCK_ASK_HISTORY_KEY = "myco.mock.askHistory";
function mockAskHistory(): unknown[] {
  try {
    const turns: unknown = JSON.parse(localStorage.getItem(MOCK_ASK_HISTORY_KEY) ?? "[]");
    return Array.isArray(turns) ? turns : [];
  } catch {
    return [];
  }
}

// ?mock=1&agent=1 flips the active query provider to an HTTP tool-capable one so
// the in-app agent loop (Feature 4) can be exercised end-to-end in the browser
// (the CLI provider tool-loops natively and isn't driven by agentLoop). Scoped
// to the flag so ordinary ?mock runs (query/study) keep the CLI provider.
const AGENT_MODE = mockParam("agent") === "1";

// ?mock=1&local=1 flips the query provider to builtin-local, the one provider
// with no generative model — which is what routes Reflect (and the session
// digest) down their EXTRACTIVE paths. Without it those paths are unreachable
// in a browser run, which is how the extractive reflect shipped unlooked-at.
const LOCAL_ONLY_MODE = mockParam("local") === "1";

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

// A concept note worth studying (lead with bold and wikilinked terms,
// citations, H2 sections) — the mock's generated pages are one generic
// sentence each, which gives Make cards nothing to show. Synthetic text.
const STUDY_NOTE = [
  "---",
  'title: "Attention Mechanism"',
  "type: technique",
  "tags:",
  "  - technique",
  "confidence: high",
  "status: active",
  "---",
  "",
  "# Attention Mechanism",
  "",
  "The **attention mechanism** lets a model weigh how relevant every input token is to every other token, building each output as a weighted sum of value vectors.[^src-attention-is-all-you-need] In the [[transformer-architecture|Transformer]] it appears as [[self-attention]], where queries, keys and values all come from the same sequence.",
  "",
  "## Scaling",
  "",
  "Attention cost grows with the square of the sequence length, which is why long contexts are expensive.[^src-attention-is-all-you-need] During generation a [[kv-cache]] keeps earlier keys and values so they are not recomputed at every step.",
  "",
  "## Many heads",
  "",
  "Running several attention heads side by side lets each one follow a different relation between tokens, and their outputs are concatenated.[^src-attention-is-all-you-need] This form is called [[multi-head-attention]] in most papers.",
  "",
  "## Related",
  "",
  "- [[embeddings]]",
  "- [[positional-encoding]]",
  "",
  "[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]",
  "",
].join("\n");

// Its deck, as Make cards saves it: a section card and a cloze card (both
// framed the same in every language, so a re-run shows them as already in
// the deck), scheduled in the past so they are due.
{
  const made = cardsFromNote(STUDY_NOTE, "attention-mechanism", STRINGS.en);
  const pick = [
    made.find((c) => c.front.includes(" › Scaling"))!,
    made.find((c) => c.front.includes(BLANK))!,
  ];
  const past = {
    due: "2024-01-01",
    stability: 2.5,
    difficulty: 5,
    reps: 1,
    lapses: 0,
    lastReview: "2024-01-01",
  };
  mockDecks.set(
    `${VAULT}/cards/attention-mechanism.md`,
    serializeDeck(pick.map((c) => ({ ...c, state: past }))),
  );
}

// A junk deck like the one the small model wrote into a real vault: generic
// prose about "the tool", no source. Study flags it and offers to archive it.
mockDecks.set(
  `${VAULT}/cards/2026-07-12.md`,
  [
    "What is the main idea of this page? ?? It explains a helpful tool that lets people learn faster with cards.",
    "<!--SR:!2024-01-01|3.1262|5.3146|1|0|2023-12-29|-->",
    "",
    "How is it used? ?? You run it with a few options and it prints the results as a list.",
    "<!--SR:!2024-01-01|3.1262|5.3146|1|0|2023-12-29|-->",
    "",
    "What are its strengths? ?? It is simple, fast and flexible for many kinds of documents.",
    "",
  ].join("\n"),
);

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
      text: "Hello myco PDF",
      color: "#ffd54f",
      note: `${VAULT}/wiki/attention-mechanism.md`,
      created: "2026-07-10T00:00:00Z",
    },
  ],
});

// Task 2 — in-memory distill config with defaults so ontology features work in mock.
let mockDistillConfig: DistillConfig = {
  enabled: true,
  count_trigger: 50,
  intensity: "standard",
  gate_preset: "normal",
  quarantine_ttl_days: 30,
  run_budget_items: 50,
  idle_minutes: 10,
  maturation_hours: 24,
  dormancy_decay: false,
  llm_digest_days: 3,
  llm_ingest_budget: 3,
  profile_injection: true,
};

// ROADMAP P2 — archive lifecycle. `?mock=1` is an all-wiki vault with no
// sessions/ or daily/ on disk, so the storage panel would otherwise always be
// empty; these are the shapes the real `archive_usage` returns.
let mockArchiveBuckets: BucketUsage[] = [
  { tree: "daily", bucket: "2026-W02", files: 7, bytes: 41_000, packed: false },
  { tree: "daily", bucket: "2026-W31", files: 7, bytes: 38_400, packed: false },
  {
    tree: "sessions",
    bucket: "2026-01",
    files: 214,
    bytes: 2_310_000,
    packed: false,
  },
  {
    tree: "sessions",
    bucket: "2026-04",
    files: 168,
    bytes: 1_870_000,
    packed: false,
  },
  {
    tree: "sessions",
    bucket: "2026-07",
    files: 121,
    bytes: 1_402_000,
    packed: false,
  },
  // The third tier's archive: rolled-up weeklies, bucketed by month like
  // sessions/ (not by week like daily/) — the mock carries one so the panel's
  // per-tree cutoff is exercisable in ?mock=1.
  { tree: "weekly", bucket: "2026-02", files: 4, bytes: 21_000, packed: false },
];

/** Standard ISO-8601 week-of-year string (`YYYY-Www`), the mock's stand-in
 *  for `distill::iso_week`'s Thursday rule: a date belongs to the week
 *  containing its Thursday, so a week straddling a year boundary keeps one
 *  name instead of splitting under two. */
function isoWeekOf(d: Date): string {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dow = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dow + 3); // nearest Thursday
  const week1Thu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const w1dow = (week1Thu.getUTCDay() + 6) % 7;
  week1Thu.setUTCDate(week1Thu.getUTCDate() - w1dow + 3);
  const weekNum =
    1 + Math.round((date.getTime() - week1Thu.getTime()) / (7 * 86_400_000));
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/** `{month, week}` cutoff `n` months back — the mock's stand-in for
 *  `archive_pack::cutoff`. The real cutoff compares each tree's bucket id
 *  against a cutoff in THAT tree's own format (sessions: `YYYY-MM`, daily:
 *  `YYYY-Www`) — comparing a `YYYY-Www` id against a `YYYY-MM` cutoff is
 *  apples to oranges lexicographically ('W' sorts above every digit), so it
 *  would never match and a daily bucket would never compress. */
function mockArchiveCutoff(
  months: number,
  now = new Date(),
): { month: string; week: string } {
  // Mirrors `archive_pack::cutoff` exactly: month arithmetic on the year*12+month
  // index (never `setUTCMonth`, which overflows Mar 31 - 1 month into March), and
  // the week taken from day 28 of the cutoff month so the subtraction can never
  // land on a non-date.
  const total = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
  const cy = Math.floor(total / 12);
  const cm = total - cy * 12; // 0-based
  const month = `${String(cy).padStart(4, "0")}-${String(cm + 1).padStart(2, "0")}`;
  return { month, week: isoWeekOf(new Date(Date.UTC(cy, cm, 28))) };
}

// Quarantine review (ROADMAP P0) — seeded so ?mock=1 renders the Feedback
// page's quarantine tab without a real vault that has something quarantined.
// Mutable: restore/keep-longer in the mock behave like the real commands.
const NOW_SECS = Math.floor(Date.now() / 1000);
let mockQuarantine: QuarantineItem[] = [
  {
    path: "_inbox/quarantine/mortgage-rates-2026.md",
    name: "mortgage-rates-2026.md",
    s_knn: 0.31,
    nearest_cluster: "transformers",
    reason:
      "nearest topic 'transformers' similarity 0.31 < quarantine 0.38 (p5) -> quarantine; 0 known entities",
    expires: NOW_SECS + 12 * 86400,
    asks_on_expiry: false,
    preview:
      "Notes from the bank call: 30-year fixed at 6.1%, points buy-down math, and the refinance break-even table I sketched on the back of the letter.",
  },
  {
    path: "_inbox/quarantine/sourdough-log.md",
    name: "sourdough-log.md",
    s_knn: 0.22,
    nearest_cluster: "rope",
    reason:
      "nearest topic 'rope' similarity 0.22 < quarantine 0.35 (p5) -> quarantine; 1 known entity",
    expires: NOW_SECS - 3600,
    asks_on_expiry: false,
    preview:
      "Day 9: starter doubles in 5h at 24C. Hydration 78% was too slack for the banneton, dropping to 72% next bake.",
  },
  {
    path: "_inbox/quarantine/clipboard-fragment.md",
    name: "clipboard-fragment.md",
    s_knn: 0,
    nearest_cluster: "",
    reason: "",
    expires: 0,
    asks_on_expiry: true,
    preview: "half a paste, no frontmatter, no verdict sidecar worth parsing",
  },
  // Machine-made sessions (spec 2026-10-02 결정 1), one or more per kind so
  // every 격리-tab group renders. Synthetic names and bodies.
  ...(
    [
      ["myco", "claude-code-00000000-0000-4000-8000-000000000101", 26,
        "You are reviewing a personal knowledge wiki (markdown files in the current directory). Find contradictions, stale claims and missing links."],
      ["myco", "claude-code-00000000-0000-4000-8000-000000000102", 27,
        "You are planning how to ingest a new source into an existing wiki. Reply with a JSON plan of pages to create or update."],
      ["myco", "claude-code-00000000-0000-4000-8000-000000000103", 28,
        "New source has been added at raw/2026-09-14-clip.md. Read it and update the wiki pages it touches."],
      ["agent", "codex-00000000-0000-4000-8000-000000000201", 25,
        "Work only in the worktree for this task. Read the spec fully first, write a failing test, implement, run the gates, then report what was verified."],
      ["agent", "codex-00000000-0000-4000-8000-000000000202", 29,
        "Work only in the worktree for this task. Read the spec fully first, write a failing test, implement, run the gates, then report what was verified."],
      ["hello", "claude-code-00000000-0000-4000-8000-000000000301", 24, "hello"],
      ["hello", "codex-00000000-0000-4000-8000-000000000302", 24, "hello-from-daemon"],
      ["empty", "claude-code-00000000-0000-4000-8000-000000000401", 23, ""],
    ] as const
  ).map(([kind, stem, days, preview]): QuarantineItem => ({
    path: `_inbox/quarantine/${stem}.md`,
    name: `${stem}.md`,
    s_knn: 0,
    nearest_cluster: "",
    reason: `machine:${kind}`,
    expires: NOW_SECS + days * 86400,
    asks_on_expiry: true,
    preview,
  })),
];

// Task 9 — three pending work/feedback/*.md proposals, so PageFeedback and the
// Overview/Sidebar badge (distill_status.pending_proposals: 3 below) render
// real content in ?mock=1. Format mirrors distill.rs's write_proposal exactly
// (frontmatter keys + a `# title` heading), so parseProposal parses these the
// same way it would parse the real file.
const MOCK_PROPOSAL_1 = `${VAULT}/work/feedback/2026-08-10-emerging-cluster-rope.md`;
const MOCK_PROPOSAL_2 = `${VAULT}/work/feedback/2026-08-11-archive-batch-stale.md`;
const MOCK_PROPOSAL_3 = `${VAULT}/work/feedback/2026-08-12-map-candidate-attention.md`;
const MOCK_PROPOSALS = new Map<string, string>([
  [
    MOCK_PROPOSAL_1,
    [
      "---",
      "type: distill-proposal",
      "action: admit-cluster",
      "status: pending",
      "created: 2026-08-10",
      'payload: {"files":["_inbox/quarantine/rope-notes.md","_inbox/quarantine/rope-followup.md","_inbox/quarantine/rope-benchmarks.md","_inbox/quarantine/rope-impl.md","_inbox/quarantine/rope-ablation.md"]}',
      "---",
      "",
      "# Emerging cluster: rope",
      "",
      "5 quarantined items look related (mean similarity 0.71):",
      "",
      "- nearest 'rope' 0.74 — _inbox/quarantine/rope-notes.md",
      "- nearest 'rope' 0.69 — _inbox/quarantine/rope-followup.md",
      "- nearest 'rope' 0.73 — _inbox/quarantine/rope-benchmarks.md",
      "- nearest 'rope' 0.70 — _inbox/quarantine/rope-impl.md",
      "- nearest 'rope' 0.68 — _inbox/quarantine/rope-ablation.md",
      "",
    ].join("\n"),
  ],
  [
    MOCK_PROPOSAL_2,
    [
      "---",
      "type: distill-proposal",
      "action: archive-batch",
      "status: pending",
      "created: 2026-08-11",
      'payload: {"files":["raw/old-clip-1.md","raw/old-clip-2.md"]}',
      "---",
      "",
      "# Archive batch: 2 stale sources",
      "",
      "2 raw sources haven't been cited in 30+ days and are proposed for archive.",
      "",
    ].join("\n"),
  ],
  // A pending draft-map proposal: the one kind the activity popover and tray
  // panel list with inline approve/reject (ROADMAP P0), so ?mock=1 has a row
  // to click. Payload carries cluster/members, not files.
  [
    MOCK_PROPOSAL_3,
    [
      "---",
      "type: distill-proposal",
      "action: draft-map",
      "status: pending",
      "created: 2026-08-12",
      'payload: {"cluster":"attention","members":["wiki/attention-mechanism.md","wiki/embeddings.md","wiki/tokenization.md","wiki/transformer.md"]}',
      "---",
      "",
      "# Map candidate: attention",
      "",
      "4 wiki pages cluster tightly enough to deserve a topic map.",
      "",
    ].join("\n"),
  ],
]);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Mock LLM output for study generation. claude_run is the CLI provider path; we
// branch on the prompt so card/quiz generation returns valid JSON while ordinary
// queries still get a plain answer.
function mockClaudeRun(prompt: string): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const p = prompt.toLowerCase();
  let stdout: string;
  if (p.includes("produce a plan") && p.includes("decision")) {
    // Ingest-plan preview (wikification v2 phase 2): return decisions over the
    // seeded pages so the plan panel renders in ?mock=1.
    stdout =
      "```json\n" +
      JSON.stringify([
        {
          subject: "scaled dot-product attention",
          decision: "UPDATE",
          target: "attention-mechanism",
          reason: "adds the scaling factor detail",
        },
        {
          subject: "flash attention",
          decision: "ADD",
          target: null,
          reason: "not yet covered by any page",
        },
        {
          subject: "token embeddings",
          decision: "MERGE",
          target: "embeddings",
          reason: "overlaps the existing page",
        },
        {
          subject: "tokenization basics",
          decision: "NOOP",
          target: "tokenization",
          reason: "already fully covered",
        },
      ]) +
      "\n```";
  } else if (p.includes("flashcard")) {
    stdout = JSON.stringify([
      {
        front: "Mock card A?",
        back: "Answer A.",
        sourceRef: "[^src-attention-is-all-you-need]",
      },
      { front: "Mock card B?", back: "Answer B.", sourceRef: "[[embeddings]]" },
    ]);
  } else if (p.includes("multiple-choice")) {
    stdout = JSON.stringify([
      {
        question: "Mock Q1?",
        choices: ["Right", "Wrong 1", "Wrong 2"],
        answer: 0,
        sourceRef: "[^src-1]",
        explanation: "The first option is correct.",
      },
      {
        question: "Mock Q2?",
        choices: ["Wrong", "Right"],
        answer: 1,
        sourceRef: "",
        explanation: "The second option is correct.",
      },
    ]);
  } else if (p.includes("dialogue") || p.includes("two-host")) {
    stdout = JSON.stringify([
      {
        speaker: "A",
        text: "Welcome — today we dig into attention.",
        cites: ["[[attention-mechanism]]"],
      },
      {
        speaker: "B",
        text: "Right. At its core it's a weighted sum over value vectors.",
        cites: ["[[attention-mechanism]]"],
      },
      {
        speaker: "A",
        text: "And multi-head attention runs several of these in parallel.",
        cites: ["[[multi-head-attention]]"],
      },
      {
        speaker: "B",
        text: "Exactly, then concatenates the results. That's the key idea.",
        cites: [],
      },
    ]);
  } else {
    stdout =
      "(mock) Claude CLI reply — the real app shells `claude --print` here.";
  }
  return { stdout, stderr: "", status: 0 };
}

// Perf harness: `?mock=1&big=N` generates a synthetic vault of ~N nodes spread
// across a dozen folders with a power-law-ish link structure, so the cosmic
// graph can be profiled at real scale (the curated NODES set is ~57). Purely a
// dev affordance — gated on the URL param, never reached in a packaged build.
function bigCount(): number {
  if (typeof window === "undefined") return 0;
  const v = mockParam("big");
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
  "neural-networks",
  "data-science",
  "keyboard-hobby",
  "spain-tech",
  "deep-learning",
  "alignment",
  "distillation",
  "rag",
  "quantization",
  "activation",
  "topics",
  "misc",
];
// `?big=N&skew=1` reproduces the real-vault shape: ONE dominant folder (~90%)
// with a handful of small ones — a single giant galaxy, which stresses the
// node-sprite overdraw and LOD far harder than the even 12-folder spread.
function bigSkew(): boolean {
  if (typeof window === "undefined") return false;
  return mockParam("skew") === "1";
}
export function bigPath(i: number): string {
  if (bigSkew()) {
    // 90% in folder 0, the rest sprinkled across the next 5.
    const f =
      bigRand(i * 7 + 3) < 0.9 ? BIG_FOLDERS[0] : BIG_FOLDERS[1 + (i % 5)];
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
    const links = new Set<string>();
    const folderStart = i - (i % 12); // rough hub within the same slice
    const hub = folderStart + (folderStart % 7); // deterministic hub target
    if (hub !== i && hub < n) links.add(bigPath(hub));
    const peers = 1 + Math.floor(bigRand(i) * 3);
    for (let k = 0; k < peers; k++) {
      const t = Math.floor(bigRand(i * 31 + k) * n);
      if (t !== i) links.add(bigPath(t));
    }
    if (links.size) {
      forward[src] = [...links];
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
  const re = (p: string): string =>
    p.startsWith(VAULT) ? root + p.slice(VAULT.length) : p;
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

// Home's "today's connections" line (UX S40) needs yesterday's links, which a
// mock that never changes cannot produce. Seed a baseline without most of the
// first note's pairs and two of its citations; that note is saved "today" in
// mtimes(), so its links read as new.
function seedDayLinks(adj: ReturnType<typeof buildAdjacency>): void {
  if (loadDayLinks(VAULT)?.day === today()) return;
  const base = snapshot(adj, VAULT);
  const rel = pathOf(NODES[0].s).slice(VAULT.length + 1);
  const kept = pathOf(NODES[0].l[0]).slice(VAULT.length + 1);
  base.pairs = base.pairs.filter((k) => !k.includes(rel) || k.includes(kept));
  base.cites[rel] = Math.max(0, (base.cites[rel] ?? 0) - 2);
  saveDayLinks(VAULT, { day: today(), base, last: base });
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
  const disputed = new Set(MOCK_QUIET ? [] : ["scaling-laws", "dpo"]);
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
  // Gap-panel data (?mock=1 screenshot/QA): one genuine missing page and two
  // malformed unresolved names (a template placeholder + dots-only), so the
  // panel's "missing" vs. "malformed" bucketing is visible without a real vault.
  // Two genuine missing pages (not one), so reflect's bulk "create missing
  // pages" button has something to count and a per-row action to show.
  const unresolved: Record<string, string[]> = {
    [pathOf("attention-mechanism")]: [
      "flash-attention-3",
      "source-<slug>",
      "...",
    ],
    [pathOf("scaling-laws")]: ["chinchilla-optimal"],
  };
  // The Tidy fixtures' links and title come from their CURRENT text, so a Tidy
  // rewrite shows in the graph (names, the missing-pages count) on the next
  // rebuild.
  const summaries = new Set(MOCK_SESSION_STEMS.map((s) => `source-${s}`));
  for (const s of MOCK_SESSION_STEMS) {
    const from = mockSummaryPath(s);
    tags[from] = ["source-summary"];
    const text = mockNotes.get(from) ?? "";
    const title = getValue(parseFrontmatter(text), "title");
    meta[from] = {
      type: "source-summary",
      confidence: "low",
      status: "active",
      sourceCount: 1,
      ...(typeof title === "string" ? { title } : {}),
    };
    for (const [, target] of text.matchAll(/\[\[([^\]|#]+)/g)) {
      if (target === `source-${s}`) continue; // its own footnote definition
      const to = SLUGS.has(target)
        ? pathOf(target)
        : summaries.has(target)
          ? mockSummaryPath(target.slice("source-".length))
          : null;
      if (!to) (unresolved[from] ||= []).push(target);
      else {
        (forward[from] ||= []).push(to);
        (backward[to] ||= []).push(from);
      }
    }
  }
  // Two notes "not downloaded yet" (iCloud), so Settings › Storage shows a
  // count and its list in ?mock=1. Still in the graph: a cached parse stays.
  const unread = [pathOf("dpo"), pathOf("planning")];
  return { forward, backward, unresolved, tags, meta, unread };
}

function body(d: Node): string {
  const links = d.l.filter((x) => SLUGS.has(x));
  const linkText = links.map((x) => `[[${x}]]`).join(", ");
  return `${d.n} is a core topic in this sample knowledge graph[^src-attention-is-all-you-need]. It connects to ${linkText}. This page ships as starter content so the graph is populated.\n\n[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]\n`;
}

/** A mock note's file text, as read_file returns it and the index chunks it. */
function noteText(d: Node): string {
  return `# ${d.n}\n\n${body(d)}`;
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
    const byFolder = new Map<
      string,
      { kind: "file"; name: string; path: string }[]
    >();
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
    ...NODES.map((d) => ({
      kind: "file",
      name: `${d.s}.md`,
      path: pathOf(d.s),
    })),
    ...MOCK_SESSION_STEMS.map((s) => ({
      kind: "file",
      name: `source-${s}.md`,
      path: mockSummaryPath(s),
    })),
  ];
  const roadmapChildren = [...mockNotes.keys()]
    .filter((p) => p.includes("/wiki/roadmaps/"))
    .map((p) => ({
      kind: "file" as const,
      name: p.split("/").pop() ?? "roadmap.md",
      path: p,
    }));
  const roadmapDir = roadmapChildren.length
    ? [
        {
          kind: "directory" as const,
          name: "roadmaps",
          path: `${VAULT}/wiki/roadmaps`,
          children: roadmapChildren,
        },
      ]
    : [];
  const deckNode = (p: string) => ({
    kind: "file" as const,
    name: p.split("/").pop() ?? "deck.md",
    path: p,
  });
  const archived = [...mockDecks.keys()].filter((p) =>
    p.startsWith(`${VAULT}/cards/archive/`),
  );
  const cardsChildren = [
    ...[...mockDecks.keys()].filter((p) => !archived.includes(p)).map(deckNode),
    ...(archived.length
      ? [
          {
            kind: "directory" as const,
            name: "archive",
            path: `${VAULT}/cards/archive`,
            children: archived.map(deckNode),
          },
        ]
      : []),
  ];
  const inboxChildren = [...mockInbox.keys()].map((p) => ({
    kind: "file" as const,
    name: p.split("/").pop() ?? "clip.md",
    path: p,
  }));
  // Holds only the `/meeting` slash template seeded below; createStarterTemplates
  // writes into mockNotes too. (With it, the picker's empty state shows only in
  // a vault without templates/.)
  const templatesChildren = [...mockNotes.keys()]
    .filter((p) => p.startsWith(`${VAULT}/templates/`))
    .map((p) => ({
      kind: "file" as const,
      name: p.split("/").pop() ?? "template.md",
      path: p,
    }));
  return [
    { kind: "file", name: "CLAUDE.md", path: `${VAULT}/CLAUDE.md` },
    { kind: "file", name: "welcome.md", path: `${VAULT}/welcome.md` },
    // Only when it has something in it, like the real scaffold's _inbox/.
    ...(inboxChildren.length
      ? [
          {
            kind: "directory" as const,
            name: "_inbox",
            path: `${VAULT}/_inbox`,
            children: inboxChildren,
          },
        ]
      : []),
    { kind: "directory", name: "audio", path: `${VAULT}/audio`, children: [] },
    {
      kind: "directory",
      name: "cards",
      path: `${VAULT}/cards`,
      children: cardsChildren,
    },
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
    {
      kind: "directory",
      name: "raw",
      path: `${VAULT}/raw`,
      children: [
        { kind: "file", name: `${MOCK_PDF_STEM}.pdf`, path: MOCK_PDF_PATH },
      ],
    },
    {
      kind: "directory",
      name: "sessions",
      path: `${VAULT}/sessions`,
      children: [
        {
          kind: "directory",
          name: "2026-09",
          path: `${VAULT}/sessions/2026-09`,
          children: MOCK_SESSION_STEMS.map((s) => ({
            kind: "file" as const,
            name: `${s}.md`,
            path: mockSessionPath(s),
          })),
        },
      ],
    },
    ...(templatesChildren.length
      ? [
          {
            kind: "directory" as const,
            name: "templates",
            path: `${VAULT}/templates`,
            children: templatesChildren,
          },
        ]
      : []),
    {
      kind: "directory",
      name: "wiki",
      path: `${VAULT}/wiki`,
      children: [...wikiChildren, ...roadmapDir],
    },
    {
      kind: "directory",
      name: "work",
      path: `${VAULT}/work`,
      children: [
        {
          kind: "directory",
          name: "feedback",
          path: `${VAULT}/work/feedback`,
          // Task 9 — two pending distill proposals so PageFeedback and the
          // Overview/Sidebar badge have real content in ?mock=1.
          children: [...MOCK_PROPOSALS.keys()].map((path) => ({
            kind: "file" as const,
            name: path.split("/").pop() ?? "proposal.md",
            path,
          })),
        },
      ],
    },
  ];
}

// Seconds added to the recent files' mtimes, one per writing-agent run
// (claude_run_stream) and one per write_file (the offline extractive ingest
// writes its pages that way). startIngest diffs file_mtimes around the run,
// and a mock run is fast enough to finish inside the second its snapshot was
// taken — wall-clock seconds alone made it read "no wiki pages changed" at
// random.
let mockAgentWrites = 0;

function mtimes(): [string, number][] {
  // A handful of recent files (so the recency glow has something to light) on
  // top of an old baseline (so timelapse ordering still spans a real range).
  const base = 1_700_000_000;
  const now = Math.floor(Date.now() / 1000) + mockAgentWrites;
  return [
    ...NODES.map(
      (d, i) =>
        [pathOf(d.s), i < 5 ? now - i * 43_200 : base + i * 3600] as [
          string,
          number,
        ],
    ),
    // Pending _inbox sources: first arrived "today", the rest earlier.
    ...[...mockInbox.keys()].map(
      (p, i) => [p, now - 600 - i * 100_000] as [string, number],
    ),
  ];
}

// Fixed authorship timestamps for the mock gutter (two and five days back).
const MOCK_HUMAN_TS = Math.floor(Date.now() / 1000) - 2 * 86400;
const MOCK_AGENT_TS = Math.floor(Date.now() / 1000) - 5 * 86400;

function provenance() {
  // Give a couple of pages resolved provenance (one imported from a ChatGPT
  // conversation, one hand-authored source) plus a dangling citation, so the
  // Provenance UI's source list renders in ?mock=1.
  const SOURCES: Record<string, ProvenanceSource[]> = {
    "attention-mechanism": [
      {
        slug: "chatgpt-ab12cd34",
        kind: "chatgpt",
        title: "How attention works",
        conversation_id: "ab12cd34-0000-4a1b-9c2d-ef3456789012",
        created: "1700000000",
        resolved: true,
      },
      {
        slug: "getting-started",
        kind: "",
        title: "Getting started",
        conversation_id: null,
        created: "2026-02-01",
        resolved: true,
      },
    ],
    embeddings: [
      {
        slug: "claude-code-7f8e",
        kind: "claude-code",
        title: "Embeddings deep-dive session",
        conversation_id: "7f8e9d0c",
        created: "1699500000",
        resolved: true,
      },
      {
        slug: "missing-source",
        kind: "",
        title: null,
        conversation_id: null,
        created: null,
        resolved: false,
      },
    ],
  };
  return NODES.map((d) => ({
    path: pathOf(d.s),
    name: `${d.s}.md`,
    cited: 1,
    total: d.t === "analysis" ? 3 : 2,
    sources: SOURCES[d.s] ?? [],
  }));
}

interface ProvenanceSource {
  slug: string;
  kind: string;
  title: string | null;
  conversation_id: string | null;
  created: string | null;
  resolved: boolean;
}

// In-memory settings/looks export file (mock mode has no real filesystem).
let lastSettingsExport: string | null = null;

const SETTINGS = {
  // All three CLI providers connected so the Model tab's picker (and any
  // screenshot of it) can show a real, non-"(default)"-only list for each.
  providers: {
    anthropic_cli: true,
    gemini_cli: true,
    codex_cli: true,
    anthropic_api: false,
    openai_api: false,
    google_api: false,
    ollama: false,
    openrouter: false,
    myco_pro: false,
    builtin_local: true,
  },
  query_provider: "anthropic-cli",
  query_model: "claude-sonnet-4-6",
  ingest_provider: "anthropic-cli",
  ingest_model: "claude-sonnet-4-6",
  query_effort: "(default)",
  ingest_effort: "(default)",
  myco_pro_url: "",
  myco_pro_email: "",
  auto_import_enabled: true,
  auto_import_interval_min: 30,
  auto_ingest_enabled: false,
  auto_reindex_enabled: false,
  auto_ingest_interval_min: 60,
  auto_reflect_enabled: false,
  auto_reflect_interval_min: 180,
  tray_resident: false,
  spotlight_shortcut: "Alt+Space",
  vault_history_enabled: false,
  pii_quarantine_enabled: false,
  search_archived_sessions: false,
  notch_enabled: false,
};

// ?mock=1&nowriter=1: no role can write prose (both on the extractive
// built-in), plus a map proposal approved before that, the stuck card the
// owner saw. Without it the proposals page's needs-writer state is unreachable
// in a browser run. SETTINGS is changed rather than overridden on read, so
// picking a writer under Settings → Model brings the usual retry back.
if (mockParam("nowriter") === "1") {
  Object.assign(SETTINGS, {
    query_provider: "builtin-local",
    query_model: "",
    ingest_provider: "builtin-local",
    ingest_model: "",
  });
  MOCK_PROPOSALS.set(
    `${VAULT}/work/feedback/2026-10-02-map-candidate-attention-mechanism.md`,
    [
      "---",
      "type: distill-proposal",
      "action: draft-map",
      "status: approved",
      "created: 2026-10-02",
      'payload: {"cluster":"attention-mechanism","members":["wiki/attention-mechanism.md","wiki/transformer.md","wiki/embeddings.md"]}',
      "---",
      "",
      "# Map candidate: attention-mechanism",
      "",
      "3 wiki pages cluster tightly enough to deserve a topic map.",
      "",
    ].join("\n"),
  );
}

/// What the main window would emit back for a spotlight question: the
/// extractive Ask format (page header + verbatim quote), so the citation
/// links and the blockquote styling are both exercised; the similarity rides
/// beside it for the details (MOCK_SPOTLIGHT_RELEVANCE).
const MOCK_SPOTLIGHT_ANSWER = [
  "**[[rotary-position-embedding]]**",
  "",
  "> RoPE encodes absolute position by rotating the query and key vectors in",
  "> 2-D subspaces, so the dot product between them depends only on their",
  "> relative offset. That is why it extrapolates further than learned",
  "> absolute embeddings.",
  "",
  "**[[attention-is-all-you-need]]**",
  "",
  "> Positional information has to be injected explicitly: self-attention is",
  "> permutation-invariant on its own.",
].join("\n");

const MOCK_SPOTLIGHT_RELEVANCE = [
  { stem: "rotary-position-embedding", similarity: 0.71 },
  { stem: "attention-is-all-you-need", similarity: 0.58 },
];

const bySlug = new Map(NODES.map((d) => [d.s, d]));

// ---- In-app agent (Feature 4) mock ----------------------------------------
const MOCK_AGENT_TOOLS = [
  {
    name: "search_vault",
    description: "Search the wiki",
    input_schema: { type: "object" },
    write: false,
  },
  {
    name: "read_page",
    description: "Read a page",
    input_schema: { type: "object" },
    write: false,
  },
  {
    name: "create_page",
    description: "Create a page",
    input_schema: { type: "object" },
    write: true,
  },
];

function mockAgentToolCall(
  _cmd: string,
  args: Record<string, unknown>,
): unknown {
  const name = String(args.name ?? "");
  const a = (args.args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "search_vault": {
      const q = String(a.query ?? "").toLowerCase();
      const hits = NODES.filter(
        (d) => d.n.toLowerCase().includes(q) || d.s.includes(q),
      )
        .slice(0, 5)
        .map((d) => ({
          path: pathOf(d.s),
          name: `${d.s}.md`,
          line: 1,
          snippet: d.n,
        }));
      return {
        hits: hits.length
          ? hits
          : [
              {
                path: pathOf(NODES[0].s),
                name: `${NODES[0].s}.md`,
                line: 1,
                snippet: NODES[0].n,
              },
            ],
      };
    }
    case "read_page": {
      const slug =
        String(a.path ?? "")
          .split("/")
          .pop()
          ?.replace(/\.md$/, "") ?? "";
      const d = bySlug.get(slug) ?? NODES[0];
      return { path: pathOf(d.s), content: `# ${d.n}\n\n${body(d)}` };
    }
    case "create_page":
      return {
        written: String(a.path ?? "wiki/new.md"),
        bytes: String(a.content ?? "").length,
      };
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
  const wantsWrite = /write|create|draft|note|page/i.test(
    userText?.content ?? "",
  );
  const hasWriteTool = tools.some((t) => t.name === "create_page");

  if (tools.length === 0) {
    return {
      text: "Partial answer at the step limit.",
      tool_calls: [],
      usage,
      stop: "stop",
    };
  }
  if (toolResults === 0) {
    return {
      text: "",
      tool_calls: [
        { id: "call_1", name: "search_vault", input: { query: "attention" } },
      ],
      usage,
      stop: "tool_use",
    };
  }
  if (toolResults === 1 && wantsWrite && hasWriteTool) {
    return {
      text: "",
      tool_calls: [
        {
          id: "call_2",
          name: "create_page",
          input: {
            path: "wiki/agent-summary.md",
            content: "# Summary\n\nDraft.",
          },
        },
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

function mockInvoke(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  switch (cmd) {
    // Native private grants and checked compiler/publication receipts cannot
    // be established by this browser-only demo. Preserve explicit failure.
    case "capture_model_role":
    case "select_model_role":
    case "set_role_automatic_use":
    case "publish_distill_note":
    case "session_compile_begin":
    case "session_compile_read":
    case "session_compile_publish":
    case "session_compile_step":
    case "session_compile_stop":
    case "inbox_source_snapshot":
    case "inbox_compile_begin":
    case "archive_inbox_source_checked":
    case "release_inbox_source":
      return Promise.reject(new Error("NATIVE_CAPABILITY_UNAVAILABLE: browser mock cannot issue role, compilation, or publication authority"));
    case "ensure_default_vault":
      return Promise.resolve(VAULT);
    case "seed_sample_vault":
      return Promise.resolve(null);
    case "open_vault":
      mockOpeningToken++;
      mockVaultOpen = true;
      return Promise.resolve({ path: VAULT, name: "myco" });
    case "close_vault":
      mockOpeningToken++;
      mockVaultOpen = false;
      return Promise.resolve(null);
    case "read_study_deck": {
      return (async () => {
        const path = String(args.path ?? "");
        const origin = args.origin as StudyDeckContext["origin"];
        assertMockStudyOpening(origin);
        assertMockStudyPath(path);
        const raw = mockDecks.get(path) ?? null;
        if (raw !== null && new TextEncoder().encode(raw).length > MAX_MOCK_STUDY_BYTES) {
          throw new Error("MOCK_STUDY_SIZE_REFUSED: demo deck exceeds one MiB");
        }
        const revision = raw === null ? null : await sha256(raw);
        assertMockStudyOpening(origin);
        if ((mockDecks.get(path) ?? null) !== raw) throw new Error("write conflict: demo deck changed during read");
        for (const [id, baseline] of mockStudyDeckSnapshots) {
          if (baseline.context.origin.openingToken !== origin.openingToken) mockStudyDeckSnapshots.delete(id);
        }
        if (mockStudyDeckSnapshots.size >= 64) throw new Error("MOCK_STUDY_CAPACITY_REFUSED: release existing demo snapshots");
        const context = { snapshotId: `mock-study-${++mockStudyDeckSnapshotId}`, origin: { ...origin }, path };
        mockStudyDeckSnapshots.set(context.snapshotId, { context, raw });
        return { context, raw: raw ?? "", revision, mockOnly: true };
      })();
    }
    case "write_study_deck": {
      return (async () => {
        const context = args.context as StudyDeckContext;
        assertMockStudyOpening(context?.origin);
        const baseline = mockStudyBaseline(context);
        const content = args.content;
        if (typeof content !== "string" || new TextEncoder().encode(content).length > MAX_MOCK_STUDY_BYTES) {
          throw new Error("MOCK_STUDY_SIZE_REFUSED: demo deck content must fit one MiB");
        }
        const revision = await sha256(content);
        assertMockStudyOpening(context.origin);
        if (mockStudyBaseline(context) !== baseline || (mockDecks.get(context.path) ?? null) !== baseline.raw) {
          throw new Error("write conflict: demo deck changed since its snapshot");
        }
        mockDecks.set(context.path, content);
        mockStudyDeckSnapshots.delete(context.snapshotId);
        return { path: context.path, origin: context.origin, state: "persisted", revision, error: null, mockOnly: true };
      })();
    }
    case "discard_study_deck_snapshot": {
      const context = args.context as StudyDeckContext;
      if (!context || !mockStudyDeckSnapshots.has(context.snapshotId)) return Promise.resolve(false);
      try { mockStudyBaseline(context); }
      catch (error) { return Promise.reject(error); }
      mockStudyDeckSnapshots.delete(context.snapshotId);
      return Promise.resolve(true);
    }
    case "agent_vault_session":
      return mockVaultOpen
        ? Promise.resolve({ vaultPath: VAULT, openingToken: String(mockOpeningToken) })
        : Promise.reject(new Error("no vault is open"));
    case "audio_overview_begin": {
      if (mockParam("audioFixture") !== "1") {
        return Promise.reject(new Error("NATIVE_CAPABILITY_UNAVAILABLE: Audio browser fixtures require explicit opt-in"));
      }
      const origin = args.origin as AudioOverviewJobContext["origin"] | undefined;
      const pagePaths = args.pagePaths;
      if (!mockVaultOpen || origin?.vaultPath !== VAULT || origin.openingToken !== String(mockOpeningToken) ||
        !Array.isArray(pagePaths) || pagePaths.length === 0 || pagePaths.some((path) =>
          typeof path !== "string" || !path.startsWith(`${VAULT}/`) || !path.endsWith(".md") ||
          path.split("/").some((segment) => segment === "." || segment === ".."))) {
        return Promise.reject(new Error("MOCK_AUDIO_SOURCE_REFUSED"));
      }
      const context = { jobId: `mock-audio-${++mockAudioJobId}`, origin: { ...origin } };
      mockAudioJobs.set(context.jobId, {
        context, pages: [...pagePaths], title: String(args.title ?? "Audio fixture"),
        dateIso: String(args.dateIso ?? ""), cancelled: false,
      });
      return Promise.resolve({ ...context, mockOnly: true });
    }
    case "audio_overview_generate": {
      return (async () => {
        const context = args.context as AudioOverviewJobContext | undefined;
        const job = context && mockAudioJobs.get(context.jobId);
        const isCurrent = () => job && !job.cancelled && mockVaultOpen &&
          context?.origin?.vaultPath === job.context.origin.vaultPath &&
          context.origin.openingToken === job.context.origin.openingToken &&
          job.context.origin.openingToken === String(mockOpeningToken);
        if (!job || !isCurrent()) throw new Error("MOCK_AUDIO_STALE_JOB");
        await sleep(Math.min(5_000, Math.max(0, Number(mockParam("audioDelayMs") ?? 200))));
        if (!isCurrent()) throw new Error("MOCK_AUDIO_CANCELLED");
        const first = job.pages[0];
        const stem = first.split("/").pop()?.replace(/\.md$/, "") ?? "source";
        const draft: AudioOverviewDraft = {
          title: job.title,
          turns: [
            { speaker: "A", text: "Synthetic browser dialogue; no model ran.", cites: [`[[${stem}]]`] },
            { speaker: "B", text: "This fixture checks player and cancellation UI only.", cites: [`[[${stem}]]`] },
          ],
          sourcePages: [first],
          context: { ...job.context, draftId: `mock-draft-${job.context.jobId}` },
          coverage: {
            selectedPages: [...job.pages], includedPages: [first], omittedPages: job.pages.slice(1),
            includedBodyRanges: [{ path: first, startByte: 0, endByte: 1 }],
            budgetBytes: 24_000, includedBodiesOnly: true,
          },
        };
        job.draft = draft;
        return { ...draft, mockOnly: true };
      })();
    }
    case "audio_overview_publish": {
      return (async () => {
        const context = args.context as AudioOverviewDraft["context"] | undefined;
        const job = context && mockAudioJobs.get(context.jobId);
        if (!job?.draft || job.cancelled || !mockVaultOpen ||
          context?.origin?.vaultPath !== job.context.origin.vaultPath ||
          context.origin.openingToken !== job.context.origin.openingToken ||
          context.draftId !== job.draft.context.draftId ||
          job.context.origin.openingToken !== String(mockOpeningToken)) {
          throw new Error("MOCK_AUDIO_DRAFT_REFUSED");
        }
        if (job.publication) return { ...job.publication, mockOnly: true };
        const slug = job.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "overview";
        const path = `${VAULT}/audio/${slug}-${job.dateIso.slice(0, 10)}.md`;
        if (mockNotes.has(path)) throw new Error("MOCK_AUDIO_TARGET_CONFLICT");
        const content = [`# Audio Overview — ${job.title}`, "", "> Synthetic browser fixture; no model inference or native publication.", "",
          ...job.draft.turns.map((turn) => `**${turn.speaker === "A" ? "Host" : "Guest"}:** ${turn.text} ${turn.cites.join(" ")}`), ""].join("\n\n");
        const revision = await sha256(content);
        if (job.cancelled || !mockVaultOpen || job.context.origin.openingToken !== String(mockOpeningToken) || mockNotes.has(path)) {
          throw new Error("MOCK_AUDIO_PUBLICATION_REFUSED");
        }
        mockNotes.set(path, content);
        job.publication = { ...job.draft.context, path, revision, state: "persisted", error: null };
        return { ...job.publication, mockOnly: true };
      })();
    }
    case "audio_overview_cancel": {
      const context = args.context as AudioOverviewJobContext | undefined;
      const job = context && mockAudioJobs.get(context.jobId);
      if (!job || context?.origin?.vaultPath !== job.context.origin.vaultPath ||
        context.origin.openingToken !== job.context.origin.openingToken) return Promise.resolve(false);
      job.cancelled = true;
      return Promise.resolve(true);
    }
    case "reflect_create_missing_page": {
      const origin = args.origin as { vaultPath?: string; openingToken?: string } | undefined;
      if (!mockVaultOpen || origin?.vaultPath !== VAULT || origin.openingToken !== String(mockOpeningToken)) {
        return Promise.reject(new Error("the active vault changed before the action started"));
      }
      const target = String(args.target ?? "");
      const path = `${VAULT}/wiki/${target.replace(/[\\/]/g, "-")}.md`;
      if (!mockNotes.has(path)) {
        mockNotes.set(path, `---\ntype: concept\ntags:\ncreated: ${today()}\nconfidence: medium\nstatus: active\n---\n\n# ${target}\n`);
      }
      return Promise.resolve(path);
    }
    case "list_files":
      return Promise.resolve(fileTree());
    case "file_mtimes":
      return Promise.resolve(mtimes());
    case "build_link_graph": {
      const adj = buildAdjacency();
      seedDayLinks(adj);
      return Promise.resolve(adj);
    }
    // The vault fingerprint. Constant here because the mock vault is in-memory
    // and never changes on disk — which is exactly right: it makes the poll's
    // steady state (revision unmoved -> skip the rebuild) the path a mock run
    // exercises.
    case "vault_revision":
      return Promise.resolve(MOCK_REVISION);
    // Multiverse (universes = registry projects UNION sibling vaults). The mock
    // presents two sibling vaults beside the open one to exercise the flow.
    case "list_universes":
      return Promise.resolve([
        {
          slug: "myco",
          title: "myco",
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
      return Promise.resolve(
        rerootAdjacency(buildAdjacency(), String(args.root ?? "x")),
      );
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
    case "scan_tasks":
      // Seeded checkbox items, plus anything written this session so add/toggle
      // actually round-trips. The due-dated pair lives in mockNotes (seeded at
      // module init) so the activity popover's check-off round-trips too.
      return Promise.resolve([
        ...tasksFromMockNotes(),
        {
          page: "daily.md",
          stem: "daily",
          line: 3,
          text: "reindex embeddings before the demo",
          done: false,
        },
        {
          page: "wiki/attention-mechanism.md",
          stem: "attention-mechanism",
          line: 42,
          text: "add the flash-attention variant",
          done: false,
        },
        {
          page: "wiki/embeddings.md",
          stem: "embeddings",
          line: 18,
          text: "cite the original word2vec paper",
          done: false,
        },
        {
          page: "daily.md",
          stem: "daily",
          line: 7,
          text: "skim the RoPE paper",
          done: true,
        },
        {
          page: "wiki/tokenization.md",
          stem: "tokenization",
          line: 25,
          text: "note the BPE merge order",
          done: true,
        },
      ]);
    case "scan_provenance":
      return Promise.resolve(provenance());
    case "validate_ingest":
      // Mock vault has no citations/frontmatter to violate — clean pass so
      // ?mock=1 ingest runs are not blocked by the deterministic validator.
      return Promise.resolve({ errors: [], warnings: [] });
    // The local (no-model) lint's per-page half. The mock vault's pages have
    // no real frontmatter to check, so this returns one finding per tier —
    // enough to exercise the report's Critical/Warning/Info rendering. The
    // link-graph half (orphans, unresolved links) is real: it comes from
    // buildAdjacency() like every other graph view in ?mock=1.
    case "lint_local":
      return Promise.resolve({
        critical: [
          {
            page: "wiki/attention-mechanism.md",
            kind: "dangling_citation",
            detail: "[^src-ghost] has no raw/ghost.md",
          },
        ],
        warning: [
          {
            page: "wiki/tokenization.md",
            kind: "source_count_mismatch",
            detail: "source_count=3 but 1 distinct citations",
          },
        ],
        info: [
          {
            page: "wiki/positional-encoding.md",
            kind: "stale_page",
            detail: "status=active, not modified in 74 days",
          },
        ],
      });
    case "get_distill_config":
      return Promise.resolve({ ...mockDistillConfig });
    case "set_distill_config": {
      const config = args.config as DistillConfig;
      mockDistillConfig = { ...config };
      return Promise.resolve(null);
    }
    case "distill_run":
      // Paced like mockReindex above: instant would resolve within the same
      // tick runDistillGuarded sets its in-flight flag, so nothing (a test,
      // the Topbar's busy chip) could ever observe the run actually running.
      return sleep(MOCK_SLOW ? 20000 : 1200).then(() => ({
        id: "19700101T000000",
        scan: {
          scored: 0,
          quarantined: 0,
          rejected: 0,
          summaries: 0,
          full: 0,
          skipped_immature: 0,
          gate_wiki_pages: null,
        },
        trashed: 0,
        proposals: 0,
        backlog_after: 0,
      }));
    case "undo_distill_run":
      return Promise.resolve(0);
    case "list_distill_runs":
      if (MOCK_QUIET) return Promise.resolve([]);
      return Promise.resolve([
        {
          id: "digest-1755740000",
          started_at: Math.floor(Date.now() / 1000) - 7200,
          moves: 3,
          trashed: 0,
          created: 2,
        },
        {
          id: "digest-1755650000",
          started_at: Math.floor(Date.now() / 1000) - 93600,
          moves: 1,
          trashed: 1,
          created: 0,
        },
      ]);
    // Run drill-in (W3–6 item 6): commit null — no git repo in a browser, so
    // ?mock=1 exercises the manifest-only (no-diff) fallback path.
    case "distill_run_detail":
      return Promise.resolve({
        id: args.id as string,
        started_at: Math.floor(Date.now() / 1000) - 7200,
        moves: [
          [
            "sessions/2026-08/claude-code-aaa.md",
            "sessions/archive/2026-08/claude-code-aaa.md",
          ],
          [
            "_inbox/clip-scaling-laws.md",
            "_inbox/.archived/clip-scaling-laws.md",
          ],
        ],
        trashed: [],
        created: ["daily/2026-08-21.md"],
        report_rel: `ingest-reports/distill-${args.id as string}.md`,
        commit: null,
      });
    // One modified file, before/after one sentence apart — seeds the diff-view
    // UI without a git repo in the browser.
    case "distill_run_diff":
      return Promise.resolve([
        {
          path: "wiki/scaling-laws.md",
          status: "modified",
          before:
            "# Scaling laws\n\nChinchilla lands at ~20 tokens per parameter. The relevance floor stays at 0.45 for now.\n",
          after:
            "# Scaling laws\n\nChinchilla lands at ~20 tokens per parameter. The relevance floor moves to 0.50 after the eval.\n",
        },
      ]);
    // Opt-in vault git history (Q4 item 1) — no repo in a browser; the flag
    // lives in the mock SETTINGS so the banner/settings card react to it.
    case "vault_history_status":
      return Promise.resolve({
        git_present: false,
        enabled: SETTINGS.vault_history_enabled,
      });
    case "init_vault_history":
      SETTINGS.vault_history_enabled = true;
      return Promise.resolve(null);
    case "commit_human_edit":
      return Promise.resolve(false);
    // Authorship (Q4 item 16): no git in a browser — the fixture drives the
    // 62/38 badge. The index marks one page as the agent's and one as a
    // person's, so the "by myco" mark, the palette's order (UX backlog S15) and
    // the human-only filter have something true to show; every other page has
    // no row — unknown, as in a vault without history.
    case "page_authorship":
      return Promise.resolve({
        agent_lines: 38,
        human_lines: 62,
        last_human_at: Math.floor(Date.now() / 1000) - 2 * 86400,
        // Line runs for the reader's authorship gutter. The mock vault has no
        // git, so these stand in for one blame of a short page: a human
        // heading, the agent's body paragraph, human again. The agent run
        // covers line 3 on purpose — that is the line `page_at_revision`
        // below returns differently, so reverting it actually restores text.
        runs: [
          { from: 1, to: 2, agent: false, sha: "1".repeat(40), ts: MOCK_HUMAN_TS },
          { from: 3, to: 3, agent: true, sha: "2".repeat(40), ts: MOCK_AGENT_TS },
          { from: 4, to: 40, agent: false, sha: "1".repeat(40), ts: MOCK_HUMAN_TS },
        ],
      });
    case "authorship_index":
      return Promise.resolve({
        "wiki/attention-mechanism.md": true,
        "wiki/self-attention.md": false,
      });
    // The parent revision the reader's revert restores. No git in a browser:
    // return the mock page with the agent's line swapped for a plausible
    // earlier one, so the gutter's revert has something to put back.
    case "page_at_revision": {
      const rel = String(args.rel ?? "");
      const slug = rel.split("/").pop()?.replace(/\.md$/, "") ?? "";
      const d = bySlug.get(slug);
      if (!d) return Promise.resolve(null);
      return Promise.resolve(`# ${d.n}\n\n${body(d)}`.replace(/^.*core topic.*$/m, "(earlier draft of this paragraph)"));
    }
    case "record_recall_miss":
      return Promise.resolve(null);
    case "record_page_open":
      return Promise.resolve(null);
    // Ask history (UX S36): the real log lives in the app data dir; here it
    // is localStorage, so ?mock=1 keeps the questions across reloads.
    case "ask_history_load":
      return Promise.resolve(mockAskHistory());
    case "ask_history_append": {
      const turns = [...mockAskHistory(), args.turn].slice(-500);
      try {
        localStorage.setItem(MOCK_ASK_HISTORY_KEY, JSON.stringify(turns));
      } catch {
        return Promise.reject(new Error("(mock) localStorage unavailable"));
      }
      return Promise.resolve(null);
    }
    // Redaction scan (Q4 item 13): the mock vault holds no secrets or PII, so
    // a clean report keeps the promotion paths flowing under ?mock=1.
    case "scan_text_secrets":
      return Promise.resolve({ secrets: [], pii: [] });
    // Retro raw/ audit (Q4 item 14): the mock vault is clean, so ?mock=1 shows
    // the green clean line with plausible counts.
    case "scan_raw_audit":
      return Promise.resolve({
        files_scanned: 14,
        history_files_scanned: 0,
        secret_hits: [],
        pii_hits: [],
        truncated: false,
      });
    // Resurface (Q4 item 10): two dormant wiki pages the seed echoes. Both
    // exist in the mock vault, so opening a candidate navigates somewhere.
    case "resurface_candidates":
      return Promise.resolve([
        {
          page: "wiki/positional-encoding.md",
          stem: "positional-encoding",
          score: 0.82,
          snippet:
            "RoPE는 위치를 더하는 대신 회전으로 새긴다 — 상대 위치가 내적에 그대로 보존된다는 점이 절대 위치 임베딩과의 결정적 차이다.",
          last_open: Math.floor(Date.now() / 1000) - 45 * 86400,
        },
        {
          page: "wiki/tokenization.md",
          stem: "tokenization",
          score: 0.74,
          snippet:
            "BPE 병합 규칙은 코퍼스 통계의 산물이라 한국어 조사가 어근에 붙은 채 토큰이 되는 경우가 많다. 어절 단위 평가로는 이 경계 오류가 보이지 않는다.",
          last_open: null,
        },
      ]);
    case "suspect_pages":
      if (MOCK_QUIET) return Promise.resolve({ pages_checked: 12, suspects: [] });
      return Promise.resolve({
        pages_checked: 12,
        suspects: [
          {
            page: "analysis-rlhf-vs-dpo.md",
            reasons: ["citation [^src-x] has no definition"],
          },
          {
            page: "scaling-laws.md",
            reasons: ["confidence: declared high, suggested low"],
          },
        ],
      });
    case "distill_status":
      return Promise.resolve({
        backlog: 12,
        pending_proposals: 3,
        last_run: 1755000000,
        last_backlogs: [40, 35, 30, 28, 22, 18, 15, 14, 13, 12],
        gate_active: true,
        last_run_id: "20250812T120000",
        wiki_pages: 340,
        // Defect G — nonzero so ?mock=1 demonstrates the pending-quarantine
        // message without needing a real vault with something quarantined.
        quarantined: 3,
      });
    case "apply_distill_proposal":
      return Promise.resolve("moved 1, skipped 0 already-processed");
    // ROADMAP P2 — archive lifecycle. The mock keeps `mockArchiveBuckets` as
    // real state so compress/restore actually move a row between loose and
    // packed in the browser, rather than returning a frozen list.
    case "archive_usage":
      return Promise.resolve(mockArchiveBuckets);
    case "compress_archives": {
      const { month, week } = mockArchiveCutoff(
        (args.olderThanMonths as number) ?? 3,
      );
      const old = mockArchiveBuckets.filter(
        (b) => !b.packed && b.bucket < (b.tree === "daily" ? week : month),
      );
      mockArchiveBuckets = mockArchiveBuckets.map((b) =>
        old.includes(b)
          ? { ...b, packed: true, bytes: Math.round(b.bytes * 0.25) }
          : b,
      );
      return Promise.resolve({
        buckets: old.length,
        files: old.reduce((n, b) => n + b.files, 0),
        reclaimed: old.reduce((n, b) => n + Math.round(b.bytes * 0.75), 0),
        failed: [],
      });
    }
    case "restore_archive_bucket": {
      const target = mockArchiveBuckets.find(
        (b) => b.tree === args.tree && b.bucket === args.bucket,
      );
      if (!target) return Promise.reject(new Error("no such archive bucket"));
      mockArchiveBuckets = mockArchiveBuckets.map((b) =>
        b === target ? { ...b, packed: false, bytes: b.bytes * 4 } : b,
      );
      return Promise.resolve({ files: target.files, bytes: target.bytes * 4 });
    }
    // Quarantine review (ROADMAP P0). Three similarity items on purpose: a
    // normal verdict, one already past its TTL, and one whose sidecar is
    // malformed (no reason, no expiry) — the three states the tab has to
    // render differently — plus machine sessions for every group.
    case "list_quarantine":
      return Promise.resolve(mockQuarantine);
    case "restore_quarantine": {
      const files = (args.files as string[]) ?? [];
      mockQuarantine = mockQuarantine.filter((q) => !files.includes(q.path));
      return Promise.resolve(
        `moved ${files.length}, skipped 0 already-processed`,
      );
    }
    case "extend_quarantine": {
      const origin = args.origin as { vaultPath?: string; openingToken?: string } | undefined;
      if (!mockVaultOpen || args.vault !== VAULT || origin?.vaultPath !== VAULT || origin.openingToken !== String(mockOpeningToken)) {
        return Promise.reject(new Error("Keep requires the current vault opening"));
      }
      const files = (args.files as string[]) ?? [];
      const days = (args.days as number) ?? 0;
      mockQuarantine = mockQuarantine.map((q) =>
        files.includes(q.path) && q.expires
          ? { ...q, expires: Math.max(q.expires, NOW_SECS) + days * 86400 }
          : q,
      );
      return Promise.resolve(files.length);
    }
    // Session-digest bookkeeping (Phase B, Task 1) — empty backlog / a fixed
    // manifest id, matching the brief's "empty list / 'digest-mock' id".
    case "digestable_session_days":
      return Promise.resolve([]);
    case "archive_digested_sessions":
      return Promise.resolve("digest-mock");
    // Weekly rollup (ROADMAP P1) — same convention one layer up: nothing
    // settled to roll up, a fixed manifest id when asked to archive.
    case "rollupable_buckets":
      return Promise.resolve([]);
    case "archive_rolled":
      return Promise.resolve("digest-mock");
    // Full-tier ingest (Phase B, Task 3) — empty backlog, same convention as
    // digestable_session_days: the real ledger is Rust-side and unit-tested there.
    case "full_tier_items":
      return Promise.resolve([]);
    case "list_wikify_pending":
      return Promise.resolve({ pendingTotal: 0, items: [] });
    case "session_summary_path":
      return Promise.resolve(null);
    case "wikify_complete_source":
      // The demo vault has no pending imported source revisions.
      return Promise.reject(new Error("No pending source revision in the demo vault"));
    // TS-side LLM-step manifest bookkeeping (Important 4, Phase B whole-
    // branch review) — no real undo manifest to extend under ?mock=1.
    case "append_distill_manifest":
      return Promise.resolve(null);
    // Menu bar tray refresh — no OS tray in a browser; accept and drop.
    case "update_tray_status":
      return Promise.resolve(null);
    // Tray popover window: serve the boot snapshot (the ?window=tray mock
    // panel has its own richer trayMock fixture) and swallow actions.
    case "get_tray_status":
      return Promise.resolve({
        running: [],
        runningHeader: "",
        waitingHeader: "",
        title: null,
        suggested: "",
        mcp: "",
        ask: "",
        distill: "",
        open: "Open myco",
        quit: "Quit myco",
        // Only the notch agenda half of `panel` is fixtured: it is the one
        // block the notch surface reads and acts on, and without it
        // `?window=notch&mock=1` can only ever show an empty notch. Rows are
        // pre-translated in the real payload too — the main window builds
        // them (lib/notchAgenda + lib/trayStatus).
        panel: {
          agenda: {
            total: 4,
            rows: [
              {
                id: "work/feedback/2026-09-01-attention.md",
                label: "attention · transformers",
                sub: "토픽 맵 작성 · 노트 6개",
                primaryLabel: "승인",
                primaryAction:
                  "proposal-approve:work/feedback/2026-09-01-attention.md",
                secondaryLabel: "무시",
                secondaryAction:
                  "proposal-reject:work/feedback/2026-09-01-attention.md",
              },
              {
                id: "wiki/otp.md|wiki/magic-links.md",
                label: "otp ↔ magic-links",
                sub: "제안된 연결",
                primaryLabel: "연결하기",
                primaryAction: "links-accept:wiki/otp.md|wiki/magic-links.md",
                secondaryLabel: "무시",
                secondaryAction: "links-dismiss:wiki/otp.md|wiki/magic-links.md",
              },
              {
                id: "harvest",
                label: "수확 대기",
                sub: "위키에 들어갈 만한 세션 12개",
                primaryLabel: "12개 수확",
                primaryAction: "harvest-run",
                secondaryLabel: "",
                secondaryAction: "",
              },
            ],
          },
        },
      });
    case "tray_panel_action":
      return Promise.resolve(null);
    case "resize_tray_panel":
      return Promise.resolve(null);
    case "spotlight_status":
      return Promise.resolve({
        shortcut: "Alt+Space",
        registered: true,
        error: null,
      });
    case "set_spotlight_shortcut":
      return Promise.resolve({
        shortcut: String(args.shortcut ?? ""),
        registered: String(args.shortcut ?? "") !== "",
        error: null,
      });
    case "close_spotlight":
    case "resize_spotlight":
      return Promise.resolve(null);
    case "notch_geometry":
      // 14" MacBook Pro shape, so the browser mock exercises the notched path.
      return Promise.resolve({
        has_notch: true,
        notch_w: 204,
        notch_h: 37,
        screen_w: 1512,
      });
    case "copy_into_inbox": {
      // Land the copy in the mock inbox so the pending list gains the row; a
      // browser cannot read the source file, so a stub body stands in.
      const name = String(args.destName ?? "drop");
      mockInbox.set(
        `${VAULT}/_inbox/${name}`,
        `(dev mock) copied from ${String(args.srcAbs ?? "")}`,
      );
      // ABSOLUTE path, matching the real command's return (notchDriver treats
      // it as the landed location).
      return Promise.resolve(`${VAULT}/_inbox/${name}`);
    }
    case "backfill_status":
      // Mirrors the real buckets so the Ingest card renders in a browser.
      return Promise.resolve({
        read_status: "complete",
        read_issues: [],
        total: 1428,
        promoted: 0,
        eligible: 175,
        too_small: 1231,
        too_large: 22,
      });
    case "promote_sessions": {
      const limit = Number(args.limit ?? 10);
      return Promise.resolve({
        promoted: Array.from({ length: limit }, (_, i) => `session-${i + 1}.md`),
        remaining: Math.max(0, 175 - limit),
      });
    }
    case "write_inbox_note": {
      // The pasted-note sibling of copy_into_inbox: same mock inbox, the
      // composed content lands as-is.
      const name = String(args.destName ?? "drop.md");
      mockInbox.set(`${VAULT}/_inbox/${name}`, String(args.content ?? ""));
      return Promise.resolve(`${VAULT}/_inbox/${name}`);
    }
    // No OS window to size or show in a browser; accept and drop.
    case "notch_resize":
      return Promise.resolve(null);
    case "capture_note": {
      // Mirrors the real command's contract (commands.rs capture_note_at):
      // whitespace collapsed, empty text refused, a missing note seeded with
      // its heading, one `- HH:MM text` line appended, and the local day's
      // vault-relative daily-note path returned with the line.
      const text = String(args.text ?? "").split(/\s+/).filter(Boolean).join(" ");
      if (text === "") {
        return Promise.reject(new Error("empty capture"));
      }
      const now = new Date();
      const rel = `daily/${today(now)}.md`;
      const body = (mockNotes.get(`${VAULT}/${rel}`) ?? `# ${today(now)}\n\n`).trimEnd();
      const line = `- ${now.toTimeString().slice(0, 5)} ${text}`;
      // A quote's footnote definition, once per note (quote_footnote; the
      // mock skips its file-exists check, having no raw/ files to check).
      const source = typeof args.source === "string" ? args.source : "";
      const name = (source.split("/").pop() ?? "").replace(/(.)\.[^.]*$/, "$1");
      const label = `[^src-${name}]`;
      const footnote =
        source.startsWith("raw/") &&
        !/\p{Cc}/u.test(source) &&
        !source.split("/").includes("..") &&
        /^[\p{L}\p{N}_-]+$/u.test(name) &&
        text.includes(label) &&
        !body.split("\n").some((l) => l.startsWith(`${label}:`))
          ? `${label}: ${source}`
          : undefined;
      mockNotes.set(`${VAULT}/${rel}`, appendCapture(`${body}\n`, line, footnote));
      const captured = footnote ? { rel, line, footnote } : { rel, line };
      emitMock("myco://daily-captured", captured);
      return Promise.resolve(captured);
    }
    // No NSPanel in a browser; claim key so the capture flow proceeds.
    case "notch_focus_capture":
      return Promise.resolve(true);
    case "update_notch_enabled":
      SETTINGS.notch_enabled = Boolean(args.enabled);
      return Promise.resolve(null);
    // The roam panel is its own OS window; a browser has none to order in.
    // `?window=roam&roamMock=1` previews what it draws instead.
    case "roam_show":
      return Promise.resolve(false);
    case "roam_hide":
      return Promise.resolve(null);
    case "roam_place":
      return Promise.resolve(null);
    case "get_settings":
      if (AGENT_MODE) {
        return Promise.resolve({
          ...SETTINGS,
          query_provider: "anthropic-api",
          query_model: "claude-sonnet-4-6",
        });
      }
      if (LOCAL_ONLY_MODE) {
        return Promise.resolve({
          ...SETTINGS,
          query_provider: "builtin-local",
          query_model: "",
        });
      }
      return Promise.resolve({ ...SETTINGS });
    case "agent_tools_schema":
      return Promise.resolve(MOCK_AGENT_TOOLS);
    case "agent_tool_call": {
      const origin = args.origin as { vaultPath?: string; openingToken?: string } | undefined;
      if (!mockVaultOpen || origin?.vaultPath !== VAULT || origin.openingToken !== String(mockOpeningToken)) {
        return Promise.reject(new Error("the active vault changed before the action started"));
      }
      return Promise.resolve(mockAgentToolCall(cmd, args));
    }
    case "agent_chat":
      return Promise.resolve(mockAgentChat(args));
    case "myco_pro_ingest":
      return Promise.resolve({
        summary: `(dev mock) ingested ${String(args.slug ?? "source")}`,
        applied: 2,
        paths: ["wiki/source-mock.md", "wiki/index.md"],
      });
    case "myco_pro_login":
      SETTINGS.myco_pro_email = String(args.email ?? "");
      SETTINGS.providers.myco_pro = true;
      return Promise.resolve({
        email: String(args.email ?? ""),
        connected: true,
      });
    case "local_query":
      // Paced, like the real thing. Measured: prefill dominates a local answer
      // (~0.67 ms/token, ~2.7 s over a full context) and a cold weight load adds
      // up to 11.7 s. A mock that answers instantly means no test — and no
      // developer — ever sees the wait states that exist because of those
      // numbers.
      return sleep(700).then(
        () =>
          "(mock) local model reply — the real app runs the bundled Gemma 3 1B here.",
      );
    case "myco_pro_logout":
      SETTINGS.myco_pro_email = "";
      SETTINGS.providers.myco_pro = false;
      return Promise.resolve(null);
    case "claude_check":
      return Promise.resolve({
        installed: true,
        version: "claude 1.0.0",
        path: "/usr/local/bin/claude",
      });
    case "agent_check":
      // gemini-cli / codex-cli install probe — mock as not installed so the
      // Connections tab renders without an undefined-status crash in dev.
      return Promise.resolve({ installed: false, version: null, path: null });
    case "ollama_status":
      // ?mock=1&ollama=1 fakes a running daemon with installed models so the
      // model list + delete UI render without a real Ollama on the machine.
      return Promise.resolve(
        mockParam("ollama") === "1"
          ? {
              binary_installed: true,
              binary_path: "/usr/local/bin/ollama",
              version: "0.5.1",
              daemon_running: true,
              endpoint: "http://localhost:11434",
              models: [
                { name: "gemma3:1b", size: 815_000_000 },
                { name: "llama3.1:8b", size: 4_700_000_000 },
              ],
              error: null,
            }
          : {
              binary_installed: false,
              binary_path: null,
              version: null,
              daemon_running: false,
              endpoint: "http://localhost:11434",
              models: [],
              error: null,
            },
      );
    case "ollama_install_url":
      return Promise.resolve("https://ollama.com/download");
    case "git_log":
      return Promise.resolve([
        {
          hash: "a1b2c3d",
          date: "2024-03-01",
          subject: "ingest: transformer architecture",
          created: 42,
          modified: 6,
        },
        {
          hash: "e4f5a6b",
          date: "2024-02-20",
          subject: "ingest: scaling laws",
          created: 30,
          modified: 3,
        },
        {
          hash: "0c1d2e3",
          date: "2024-02-10",
          subject: "init: wiki bootstrap",
          created: 120,
          modified: 0,
        },
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
      mockAgentWrites++;
      const runId = String(args.runId ?? args.run_id ?? "");
      const emit = (kind: string, extra: Record<string, unknown>) =>
        emitMock("claude-stream", {
          run_id: runId,
          kind,
          tool: null,
          detail: null,
          text: null,
          ...extra,
        });
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
    case "write_asset":
      return Promise.resolve("assets/20260101-000000.png");
    case "copy_asset":
      return Promise.resolve("assets/20260101-000000.png");
    case "read_file": {
      const p = String(args.path ?? "");
      if (p.endsWith("/.myco/favorites.json")) {
        return Promise.resolve({
          path: p,
          raw: JSON.stringify(mockFavorites),
          content: "",
          frontmatter: null,
        });
      }
      if (p.includes("/ingest-reports/")) {
        const raw =
          "# Ingest report — attention\n\nAdded 3 facts, merged 1, cited 2 sources.\n";
        return Promise.resolve({
          path: p,
          raw,
          content: raw,
          frontmatter: null,
        });
      }
      const written = mockNotes.get(p);
      if (written !== undefined) {
        return Promise.resolve({
          path: p,
          raw: written,
          content: written,
          frontmatter: null,
        });
      }
      // A clip waiting in _inbox/ — auto-ingest reads it before ingesting.
      const clip = mockInbox.get(p);
      if (clip !== undefined) {
        return Promise.resolve({
          path: p,
          raw: clip,
          content: clip,
          frontmatter: null,
        });
      }
      if (isCardsPath(p)) {
        const raw = mockDecks.get(p) ?? "";
        return Promise.resolve({
          path: p,
          raw,
          content: raw,
          frontmatter: null,
        });
      }
      const proposal = MOCK_PROPOSALS.get(p);
      if (proposal !== undefined) {
        return Promise.resolve({
          path: p,
          raw: proposal,
          content: proposal,
          frontmatter: null,
        });
      }
      if (p === MOCK_ANNOTATIONS_PATH) {
        return Promise.resolve({
          path: p,
          raw: MOCK_SIDECAR,
          content: MOCK_SIDECAR,
          frontmatter: null,
        });
      }
      if (p === MOCK_PDF_LINK_NOTE) {
        const body = `# PDF demo\n\nSee the source: [[pdf::${MOCK_PDF_STEM}#p1:seed1|Hello myco PDF]].\n`;
        return Promise.resolve({
          path: p,
          raw: body,
          content: body,
          frontmatter: null,
        });
      }
      // Generated month hub pages are guarded by a marker the generator looks
      // for in the EXISTING file, so the blanket "Sample note." fallback below
      // would read as "a user took this page over" and stop every write. An
      // unwritten hub has to miss, the way a real vault's would.
      if (/\/wiki\/tasks\/\d{4}-\d{2}\.md$/.test(p)) {
        return Promise.reject(new Error(`no such file: ${p}`));
      }
      // Same for a daily note: openDailyNote creates a missing day with its
      // heading, and the sample body would hide that. A day that was written
      // or captured was already found in mockNotes above.
      if (/\/daily\/\d{4}-\d{2}-\d{2}\.md$/.test(p)) {
        return Promise.reject(new Error(`no such file: ${p}`));
      }
      // And an unwritten topic map: maps.ts freeMapPath probes
      // wiki/maps/<slug>[-N].md until a read misses, so a hit on every name
      // spun that loop forever and hung the page on a map approve.
      if (/\/wiki\/maps\/[^/]+\.md$/.test(p)) {
        return Promise.reject(new Error(`no such file: ${p}`));
      }
      const slug = p.split("/").pop()?.replace(/\.md$/, "") ?? "";
      const d = bySlug.get(slug);
      if (d) {
        const content = noteText(d);
        return Promise.resolve({
          path: p,
          raw: content,
          content,
          frontmatter: frontmatter(d),
        });
      }
      return Promise.resolve({
        path: p,
        raw: "# myco\n\nSample note.\n",
        content: "# myco\n\nSample note.\n",
        frontmatter: null,
      });
    }
    case "read_vault_context":
      return Promise.resolve(
        NODES.map((d) => `===== wiki/${d.s}.md =====\n${body(d)}`).join("\n\n"),
      );
    case "list_provider_models":
      // Mirrors the backend's per-provider lists so the Model tab (and any
      // screenshot of it) shows what the real app would. codex-cli is the one
      // CLI whose list is fetched live — from its own on-disk model cache.
      return Promise.resolve(
        args.providerId === "codex-cli"
          ? [
              "gpt-5.6-sol",
              "gpt-5.6-sol-wm",
              "gpt-5.6-terra",
              "gpt-5.6-luna",
              "gpt-5.5",
              "gpt-5.4",
              "gpt-5.4-mini",
              "gpt-5.3-codex-spark",
              "codex-auto-review",
            ]
          : ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
      );
    // MOCK: the browser has no native GGUF runtime or downloaded weights.
    case "local_chat_model_available":
      return Promise.resolve(false);
    case "local_chat_status":
      // MOCK: this browser has no GGUF file or native inference runtime.
      return Promise.resolve({ model_id: args?.modelId ?? BUILTIN_CHAT_MODEL, state: "missing", bytes: 0 });
    case "download_local_chat_model":
      // MOCK: never represent a browser preview as a completed model download.
      return Promise.resolve({ model_id: args?.modelId ?? BUILTIN_CHAT_MODEL, state: "error", bytes: 0, reason: "mock_download_unavailable" });
    case "cancel_local_chat_model_download":
    case "cancel_local_synthesis":
      return Promise.resolve(false);
    case "local_synthesize":
    case "local_transform":
      // MOCK: Ask keeps its actual sample-note quotes; no fake model prose.
      return Promise.resolve({ answer: "", model_id: (args?.request as Record<string, unknown> | undefined)?.modelId ?? BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "mock_inference_unavailable" });
    case "local_query_plan":
      // MOCK: period selection requires a real local model; never fake its judgment.
      return Promise.reject(new Error("mock_inference_unavailable"));
    // Semantic layer (Feature 1) — mock the embedding index with the sample graph:
    // "similarity" stands in as a node's declared links + a couple of siblings.
    case "reindex_embeddings":
      return mockReindex();
    case "embeddings_status":
      return Promise.resolve({
        indexed_pages: mockIndexedPages ?? NODES.length,
        // Must track BUILTIN_EMBED_MODEL: an outdated id makes isIndexStale()
        // flag the mock index stale, which silently skips semantic retrieval
        // in every ?mock=1 flow (Ask, CLI injection, Related).
        model: "builtin-local:e5-small-ko",
      });
    case "temporal_recall":
      // MOCK: the sample graph has no original turn-date evidence. Browser
      // recall tests supply explicit dated fixtures through their IPC override.
      return Promise.resolve({
        events: [], indexed_pages: 0, scanned_pages: 0,
        matched_events: 0, incomplete: true,
      });
    case "activity_recall":
      // MOCK: this preview does not scan real date-grounded activity records.
      return Promise.resolve({ hits: [], indexed_pages: 0, scanned_pages: 0,
        matched_chunks: 0, incomplete: true });
    // Retrieval costs a query embedding against the real model (~460 ms for a
    // chunk-sized text), so it is not free here either.
    case "semantic_search": {
      const q = String(args.query ?? "").toLowerCase();
      const k = Number(args.k ?? 8);
      const scope = String(args.scope ?? "wiki");
      const weights = {
        ...DEFAULT_TIER_WEIGHTS,
        ...((args.tierWeights as Partial<TierWeights> | undefined) ?? {}),
      };
      // Match on any meaningful TOKEN, not the whole query string: the real
      // backend matches by meaning, so a mock that needed the entire sentence
      // to appear verbatim sent every realistic question ("what is attention?")
      // down the no-match fallback below — which now means "abstain", so
      // mock-driven tests could not reach the answer path at all.
      const terms = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
      const matched = NODES.filter((d) => {
        const hay = `${d.n} ${body(d)}`.toLowerCase();
        return terms.some((w) => hay.includes(w));
      });
      const wikiHits: ScoredChunk[] = matched.slice(0, k).map((d, i) => ({
        page: `wiki/${d.s}.md`,
        stem: d.s,
        section: 0,
        // The chunk the real index would return: a mock note is one heading
        // and a short body, so its only chunk is the whole (trimmed) file.
        text: noteText(d).trim(),
        score: 0.9 - i * 0.05,
        // A keyword match stands in for a confident hit here, so these sit
        // above RELEVANCE_FLOOR (0.42) and survive filtering.
        similarity: 0.68 - i * 0.02,
      }));
      // The real index also holds machine-written pages (`daily/` digests are
      // indexed — see collect_wiki_pages) and the lexical arm returns hits with
      // NO cosine at all (similarity: null). Neither exists in the wiki-only
      // sample graph, so a browser run could not see the ladder's tier chips
      // or the "keyword match" band. Inserted mid-ranking (not appended): the
      // answer only quotes the top 5 PAGES, so a tail entry would never show.
      if (wikiHits.length > 0) {
        wikiHits.splice(
          2,
          0,
          {
            page: "daily/2026-08-19.md",
            stem: "2026-08-19",
            section: 0,
            text: `digest bullet mentioning ${terms[0]}`,
            score: 0.8,
            similarity: 0.58,
          },
          {
            page: "weekly/2026-W34.md",
            stem: "2026-W34",
            section: 0,
            text: `weekly rollup line mentioning ${terms[0]}`,
            score: 0.78,
            similarity: null,
          },
        );
      }
      // Session scope: the session corpus, plus `sessions/archive/` only when
      // the opt-in flag is on (the real index keeps the cold tier out).
      const sessionHits: ScoredChunk[] = matched.length
        ? [
            {
              page: "sessions/2026-08/codex-019fdc04.md",
              stem: "codex-019fdc04",
              section: 0,
              text: `[User] ${terms[0]} 정리해줘 [lead] ${terms[0]} 관련 노트를 두 갈래로 나눠 정리했습니다. 초안 생성 완료 [[TASK_DONE]]`,
              score: 0.86,
              similarity: 0.63,
            },
            {
              page: "sessions/2026-07/codex-019fdc7b.md",
              stem: "codex-019fdc7b",
              section: 0,
              text: `[User] ${terms[0]} 다시 [lead] 지난번 결론을 로그 스케일로 다시 그리면 직선이 보입니다`,
              score: 0.74,
              similarity: 0.57,
            },
            ...(SETTINGS.search_archived_sessions
              ? [
                  {
                    page: "sessions/archive/2026-08/codex-019f9a12.md",
                    stem: "codex-019f9a12",
                    section: 0,
                    text: `[User] ${terms[0]} 문제 3주 전에 어떻게 풀었지 [lead] 학습률을 √2배로만 올리고 워밍업을 2배로 늘려 해결했습니다.`,
                    score: 0.82,
                    similarity: 0.66,
                  },
                ]
              : []),
          ]
        : [];
      // "Ask this note": the backend keeps only these pages, before the cut.
      const only = args.paths as string[] | undefined;
      const inPaths = (h: ScoredChunk): boolean => !only || only.includes(h.page);
      const pool = (
        scope === "sessions"
          ? sessionHits
          : scope === "all"
            ? [...wikiHits, ...sessionHits]
            : scope === "pages"
              ? wikiHits.filter((h) => h.page.startsWith("wiki/"))
              : wikiHits
      ).filter(inPaths);
      // No keyword match: return weak hits the way the real backend does for an
      // off-vault question — below the floor, so they come back as near-misses
      // and the abstention card (not the answer) is what a nonsense query shows.
      const weak: ScoredChunk[] =
        pool.length === 0 && NODES.length
          ? NODES.slice(0, 4).map((d, i) => ({
              page: scope === "sessions" ? `sessions/2026-08/codex-${d.s.slice(0, 8)}.md` : `wiki/${d.s}.md`,
              stem: d.s,
              section: 0,
              text: `passage from ${d.s}`,
              score: 0.6 - i * 0.05,
              similarity: i === 3 ? null : 0.4 - i * 0.03,
            })).filter(inPaths)
          : [];
      // Tier prior, applied after the per-page cap exactly like the backend:
      // final = rrf × prior, re-sorted, rank change measured against the
      // pure-RRF order.
      const tierOf = (page: string): HitTier => hitTier(sourceTier(page));
      const withPrior = (hs: ScoredChunk[]): ScoredChunk[] => {
        const base = [...hs].sort((a, b) => b.score - a.score);
        return hs
          .map((h) => {
            const tier = tierOf(h.page);
            const prior = weights[tier];
            return { ...h, tier, prior, score_rrf: h.score, score_final: h.score * prior };
          })
          .sort((a, b) => b.score_final - a.score_final)
          .map((h, i) => ({
            ...h,
            rank_change: base.findIndex((b) => b.page === h.page) - i,
          }));
      };
      const ranked = withPrior(pool).slice(0, k);
      // Time-anchored question: the real backend keeps only dated-tier pages
      // overlapping the range (simplified here to the tiers the fixtures have —
      // daily by day, sessions/monthly by month; undated wiki pages drop out).
      const range = args.range as { start: string; end: string } | undefined;
      const ranged = range
        ? ranked.filter((h) => {
            const day = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(h.page)?.[1];
            if (day) return range.start <= day && day <= range.end;
            const month =
              /^sessions\/(?:archive\/)?(\d{4}-\d{2})\//.exec(h.page)?.[1] ??
              /^monthly\/(\d{4}-\d{2})\.md$/.exec(h.page)?.[1];
            if (month)
              return (
                range.start.slice(0, 7) <= month &&
                month <= range.end.slice(0, 7)
              );
            return false;
          })
        : ranked;
      const result: SemanticSearchResult = {
        hits: ranged,
        floor: 0.42,
        below_floor: withPrior(weak).map((h) => ({
          page: h.page,
          tier: h.tier as HitTier,
          score_final: h.score_final as number,
          similarity: h.similarity,
        })),
      };
      return sleep(400).then(() => result);
    }
    case "classify_intent": {
      // No embedder in mock mode, so stand in with the shape of the real
      // verdict: a question about the vault's own files routes, anything else
      // returns null (an ordinary content question).
      const q = String(args.query ?? "");
      const meta =
        /오늘|어제|이번\s*주|최근|요즘|신규|today|yesterday|this week|recent|newest|latest/i.test(
          q,
        ) && /파일|노트|문서|md|file|note|page|doc/i.test(q);
      return sleep(200).then(() =>
        meta ? { intent: "vault-files", similarity: 0.86 } : null,
      );
    }
    case "semantic_map": {
      const count = bigCount();
      if (count > 0) {
        // MOCK: keep every large-vault note represented in the synthetic PCA.
        // Returning only the small fixture parked all other notes on a ring.
        return Promise.resolve(Array.from({ length: count }, (_, i) => {
          const group = i % BIG_FOLDERS.length;
          const angle = group / BIG_FOLDERS.length * Math.PI * 2;
          return {
            page: bigPath(i),
            x: Math.cos(angle) * 0.6 + (bigRand(i * 13 + 1) - 0.5) * 0.5,
            y: Math.sin(angle) * 0.6 + (bigRand(i * 17 + 2) - 0.5) * 0.5,
            z: Math.sin(angle * 2) * 0.4 + (bigRand(i * 23 + 3) - 0.5) * 0.5,
          };
        }));
      }
      // Structured fake PCA: one 2D cluster per node TYPE, deterministic
      // per-index jitter — the semantic layout shows meaning-clusters in mock.
      const types = [...new Set(NODES.map((d) => d.t))];
      return Promise.resolve(
        NODES.map((d, i) => {
          const k = types.indexOf(d.t);
          const ang = (k / Math.max(1, types.length)) * Math.PI * 2;
          const jx = (((i * 37) % 100) / 100 - 0.5) * 0.5;
          const jy = (((i * 61) % 100) / 100 - 0.5) * 0.5;
          const jz = (((i * 43) % 100) / 100 - 0.5) * 0.7;
          return {
            page: pathOf(d.s),
            x: Math.max(-1, Math.min(1, Math.cos(ang) * 0.62 + jx)),
            y: Math.max(-1, Math.min(1, Math.sin(ang) * 0.62 + jy)),
            z: Math.max(-1, Math.min(1, jz)),
          };
        }),
      );
    }
    case "wikify_candidates": {
      // Retrieval grounding: match the source text against node bodies, exclude
      // source-summary/structural stems, return a ranked candidate list.
      const text = String(args.sourceText ?? "").toLowerCase();
      const k = Number(args.k ?? 8);
      const scored = NODES.filter(
        (d) => !d.s.startsWith("source-") && d.s !== "index" && d.s !== "log",
      )
        .map((d) => {
          const hay = (d.n + " " + body(d)).toLowerCase();
          const words = text.split(/\W+/).filter((w) => w.length > 3);
          const overlap = words.filter((w) => hay.includes(w)).length;
          return { d, overlap };
        })
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, k)
        .map((x, i) => ({
          page: `wiki/${x.d.s}.md`,
          stem: x.d.s,
          score: 0.88 - i * 0.06,
        }));
      return sleep(500).then(() => scored);
    }
    case "describe_image":
      // Browser fixtures may override this command with clearly synthetic IPC;
      // the demo itself cannot issue a native Compilation/vision grant.
      return Promise.reject({
        version: "ImageIngestFailureV1",
        code: "capability_unavailable",
      });
    case "cancel_image_ingest":
      return Promise.resolve(false);
    case "whisper_check":
      return Promise.resolve({
        installed: true,
        version: "whisper 1.0",
        path: "/usr/local/bin/whisper",
      });
    // Voice quick-capture (W3–6 item 9): the delay exercises the "saving"
    // state before the saved chip.
    case "save_voice_capture":
      return sleep(600).then(() => ({
        rel: "_inbox/voice-2026-08-22-0912.md",
        first_line: "오늘 회의에서 정리한 내용을 잊기 전에 짧게 메모로 남겨 둡니다",
      }));
    case "transcribe_partial": {
      // The raw body IS the WAV (16 kHz mono 16-bit = 32 kB/s); one more word
      // per recorded second, so `?mock=1` captions visibly grow.
      const secs = ((args as unknown as { byteLength?: number }).byteLength ?? 0) / 32_000;
      const words = "오늘 회의에서 정리한 내용을 잊기 전에 짧게 메모로 남겨 둡니다".split(" ");
      return sleep(400).then(() => words.slice(0, 1 + Math.floor(secs)).join(" "));
    }
    case "transcribe_media":
      return Promise.resolve(
        "(mock) Transcript: today we cover attention and how scaled dot-product attention works.",
      );
    // S38: a private-network host refuses like the Rust guard does, so the
    // error line is reachable under ?mock=1; anything else is one article.
    case "fetch_web_page": {
      const url = String(args.url ?? "");
      if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url)) {
        return sleep(300).then(() => Promise.reject("blocked"));
      }
      return sleep(600).then(() => ({
        url,
        title: "How attention works",
        markdown:
          "# How attention works\n\nAttention lets a model weigh every token against every other.\n\n" +
          "Scaled dot-product attention divides by the square root of the key size.",
      }));
    }
    case "fetch_youtube_transcript":
      return Promise.resolve(
        "hello and welcome to this talk\ntoday we cover transformers and attention\n" +
          "the key idea is scaled dot-product attention\nthanks for watching",
      );
    // Deterministic toy vectors — enough for the extractive session digest to
    // rank/diversify under ?mock=1, no semantic meaning intended.
    case "embed_local_texts": {
      const texts = (args.texts ?? []) as string[];
      return Promise.resolve(
        texts.map((t) => {
          const v = new Array(8).fill(0);
          for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 32;
          const n = Math.hypot(...v) || 1;
          return v.map((x: number) => x / n);
        }),
      );
    }
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
        links.slice(0, k).map((s, i) => ({
          page: `wiki/${s}.md`,
          stem: s,
          section: 0,
          score: 0.85 - i * 0.05,
        })),
      );
    }
    // Explicit browser-demo editor receipts. These implement synthetic CAS
    // for the demo UI and never grant native/model/compiler authority.
    case "editor_recovery_supported":
      return Promise.resolve(true);
    case "read_editor_file": {
      return (async () => {
        const path = String(args.path ?? "");
        if (!path.startsWith(`${VAULT}/`) || path.split("/").some((part) => part === "." || part === "..")) {
          throw new Error("MOCK_EDITOR_PATH_REFUSED: file must be inside the browser demo vault");
        }
        const origin = args.origin as { vaultPath?: string; openingToken?: string } | undefined;
        const isCurrent = () => mockVaultOpen && origin?.vaultPath === VAULT &&
          origin.openingToken === String(mockOpeningToken);
        if (!isCurrent()) throw new Error("MOCK_EDITOR_STALE_OPENING: browser demo opening changed");
        const file = await mockInvoke("read_file", { path }) as { path: string; raw: string };
        const revision = await sha256(file.raw);
        if (!isCurrent()) throw new Error("MOCK_EDITOR_STALE_OPENING: browser demo opening changed");
        mockEditorBaselines.set(`${origin!.openingToken}:${path}:${revision}`, file.raw);
        return { file, origin, revision, mockOnly: true };
      })();
    }
    case "stage_editor_draft":
    case "read_editor_draft":
    case "retire_editor_draft": {
      return (async () => {
        const path = String(args.path ?? "");
        if (!path.startsWith(`${VAULT}/`) || path.split("/").some((part) => part === "." || part === "..")) {
          throw new Error("MOCK_EDITOR_PATH_REFUSED: file must be inside the browser demo vault");
        }
        const protection = protectedMutation(path);
        if (protection) throw protection;
        const origin = args.origin as { vaultPath?: string; openingToken?: string } | undefined;
        if (!mockVaultOpen || origin?.vaultPath !== VAULT || origin.openingToken !== String(mockOpeningToken)) {
          throw new Error("MOCK_EDITOR_STALE_OPENING: browser demo opening changed");
        }
        const current = mockEditorDrafts.get(path);
        if (cmd === "read_editor_draft") return current ? { ...current, origin: { ...current.origin } } : null;
        if (args.expectedJournalRevision !== (current?.revision ?? null)) {
          throw new Error("MOCK_EDITOR_JOURNAL_CONFLICT: checkpoint changed");
        }
        if (cmd === "retire_editor_draft") {
          if (!current) throw new Error("MOCK_EDITOR_JOURNAL_MISSING: checkpoint is absent");
          mockEditorDrafts.delete(path);
          return null;
        }
        const expected = args.expectedSha256;
        if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || typeof args.draft !== "string") {
          throw new Error("MOCK_EDITOR_BASELINE_REQUIRED: exact native-read-like baseline is required");
        }
        const baselineRaw = mockEditorBaselines.get(`${origin.openingToken}:${path}:${expected}`);
        if (baselineRaw === undefined || (current && (current.baselineRevision !== expected ||
          current.origin.openingToken !== origin.openingToken))) {
          throw new Error("MOCK_EDITOR_BASELINE_REQUIRED: checkpoint cannot rebind an original baseline");
        }
        const checkpoint: MockEditorDraft = {
          path, baselineRaw, baselineRevision: expected, draftRaw: args.draft,
          revision: (++mockEditorDraftRevision).toString(16).padStart(32, "0"),
          origin: { vaultPath: VAULT, openingToken: origin.openingToken }, mockOnly: true,
        };
        mockEditorDrafts.set(path, checkpoint);
        return { ...checkpoint, origin: { ...checkpoint.origin } };
      })();
    }
    case "write_editor_file": {
      return (async () => {
        const path = String(args.path ?? "");
        if (!path.startsWith(`${VAULT}/`) || path.split("/").some((part) => part === "." || part === "..")) {
          throw new Error("MOCK_EDITOR_PATH_REFUSED: file must be inside the browser demo vault");
        }
        const protection = protectedMutation(path);
        if (protection) throw protection;
        const origin = args.origin as { vaultPath?: string; openingToken?: string } | undefined;
        const isCurrent = () => mockVaultOpen && origin?.vaultPath === VAULT &&
          origin.openingToken === String(mockOpeningToken);
        if (!isCurrent()) throw new Error("MOCK_EDITOR_STALE_OPENING: browser demo opening changed");
        const expected = args.expectedSha256;
        if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
          throw new Error("MOCK_EDITOR_BASELINE_REQUIRED: exact first-read revision is required");
        }
        await mockInvoke("write_file_if_unchanged", { path, content: args.content, expectedSha256: expected, editorOrigin: origin });
        const file = await mockInvoke("read_file", { path }) as { path: string; raw: string };
        const revision = await sha256(file.raw);
        if (!isCurrent()) throw new Error("MOCK_EDITOR_STALE_OPENING: browser demo opening changed after persisted write");
        mockEditorBaselines.set(`${origin!.openingToken}:${file.path}:${revision}`, file.raw);
        return { path: file.path, origin, revision, mockOnly: true };
      })();
    }
    case "write_file_if_unchanged": {
      return (async () => {
        const p = String(args.path ?? "");
        if (/\/raw\//.test(p)) throw new Error("refused: raw/ is immutable");
        const readCurrent = async (): Promise<string | null> => {
          try { return ((await mockInvoke("read_file", { path: p })) as { raw: string }).raw; }
          catch (error) {
            if (!/ENOENT|no such file:/i.test(String(error))) throw error;
            return null;
          }
        };
        const current = await readCurrent();
        const expected = args.expectedSha256;
        if (expected !== null && (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))) {
          throw new Error("expected SHA256 must be 64 lowercase hexadecimal characters");
        }
        const actual = current === null ? null : await sha256(current);
        if (expected !== actual || current !== await readCurrent()) {
          throw new Error("write conflict: file changed before save");
        }
        const editorOrigin = args.editorOrigin as { vaultPath?: string; openingToken?: string } | undefined;
        if (editorOrigin && (!mockVaultOpen || editorOrigin.vaultPath !== VAULT || editorOrigin.openingToken !== String(mockOpeningToken))) {
          throw new Error("MOCK_EDITOR_STALE_OPENING: browser demo opening changed before save");
        }
        return mockInvoke("write_file", { path: p, content: args.content });
      })();
    }
    case "write_file": {
      const p = String(args.path ?? "");
      const content = String(args.content ?? "");
      mockAgentWrites++;
      // A proposal write (approve/dismiss rewrites its `status:` line) has to
      // land back in MOCK_PROPOSALS — read_file checks that map first, so
      // writing into mockNotes would leave the row stuck at `pending`.
      if (MOCK_PROPOSALS.has(p)) MOCK_PROPOSALS.set(p, content);
      else if (isCardsPath(p)) mockDecks.set(p, content);
      else mockNotes.set(p, content);
      return Promise.resolve(null);
    }
    case "delete_path": {
      // Consuming an inbox source removes it, which is how auto-ingest avoids
      // ingesting the same clip forever.
      const target = String(args.path ?? "");
      const error = protectedMutation(target);
      if (error) return Promise.reject(error);
      mockInbox.delete(target);
      // A quarantined file deleted from the sidebar comes through here, so
      // the mock list has to lose the item too — paths arrive absolute here.
      const rel = target.startsWith(`${VAULT}/`)
        ? target.slice(VAULT.length + 1)
        : target;
      mockQuarantine = mockQuarantine.filter((q) => q.path !== rel);
      return Promise.resolve(null);
    }
    case "trash_paths": {
      // delete_path for a list (the 격리 tab's trash); absolute paths.
      const targets = (args.paths as string[]) ?? [];
      for (const path of targets) {
        const error = protectedMutation(path);
        if (error) return Promise.reject(error);
      }
      targets.forEach((p) => mockInbox.delete(p));
      const rels = targets.map((p) =>
        p.startsWith(`${VAULT}/`) ? p.slice(VAULT.length + 1) : p,
      );
      mockQuarantine = mockQuarantine.filter((q) => !rels.includes(q.path));
      return Promise.resolve(null);
    }
    case "archive_inbox_source": {
      // Same effect on the inbox as delete_path — the source leaves the tray —
      // but it moves to .archived/ instead of vanishing.
      const p = String(args.path ?? "");
      const inboxPrefix = `${VAULT}/_inbox/`;
      if (!p.startsWith(inboxPrefix) || p.slice(inboxPrefix.length).split("/").some((part) => !part || part === "." || part === "..")) {
        return Promise.reject(new Error("refused: only _inbox sources can be archived"));
      }
      if (!mockInbox.has(p)) return Promise.reject(new Error(`not a file: ${p}`));
      mockInbox.delete(p);
      if (args.completeHarvest === true) {
        const source = mockHarvestCopies.get(p);
        if (source) mockHarvested.add(source);
        mockHarvestCopies.delete(p);
      }
      const name = p.split("/").pop() ?? "source.md";
      return Promise.resolve(`${VAULT}/_inbox/.archived/${name}`);
    }
    case "list_inbox_entries": {
      // Every pending file, any extension — mirrors mtimes(): the first
      // arrived "today", the rest earlier.
      const now = Math.floor(Date.now() / 1000);
      return Promise.resolve(
        [...mockInbox.entries()].map(([p, content], i) => {
          const name = p.split("/").pop() ?? "clip.md";
          const dot = name.lastIndexOf(".");
          return {
            name,
            rel: `_inbox/${name}`,
            ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
            bytes: content.length,
            mtime: now - 600 - i * 100_000,
          };
        }),
      );
    }
    case "available_raw_path": {
      // The mock raw/ is a fixed fixture with no dynamic sources, so nothing
      // collides — return the plain path. (Real collision handling is Rust-side
      // and unit-tested there.)
      const stem = String(args.stem ?? "source");
      return Promise.resolve(`raw/${stem}.md`);
    }
    case "find_raw_copy":
      // Same fixed fixture: no ingested body to match. (The byte match is
      // Rust-side and unit-tested there.)
      return Promise.resolve(null);
    case "derived_raw_copy":
      // No marked raw copy either; the hash and the header scan are
      // Rust-side and unit-tested there.
      return Promise.resolve({
        marker: `<!-- myco:source-sha256 ${"0".repeat(64)} -->`,
        copy: null,
      });
    case "import_conversations": {
      // The real parse/scan/write is Rust; the mock can't read the picked file,
      // so it returns a plausible outcome (one imported, one quarantined) so the
      // import UI's success and secret-warning states are both exercisable.
      // Single-file: instant, no progress stream, no failures.
      return Promise.resolve({
        source: "claude-code",
        imported: 1,
        skipped: 2,
        quarantined: [
          {
            title: "a chat that pasted a key",
            secrets: ["OpenAI/Anthropic-style API key"],
          },
        ],
        failed: [],
      });
    }
    case "import_session_sweep":
      // Emit a paced import-progress stream (like the real sweep) so the progress
      // bar and tallies are exercisable, then return a result with two failures
      // so the failures list + retry are too. The real mock's instant return
      // would hide exactly this.
      return mockImportSweep(String(args.kind ?? "claude-code"));
    case "import_paths":
      // Retry succeeds: the previously-failed files now import; failed list clears.
      return Promise.resolve({
        source: "claude-code",
        imported: Array.isArray(args.paths) ? args.paths.length : 1,
        skipped: 0,
        quarantined: [],
        failed: [],
      });
    case "set_settings":
      // Actually persist. Returning null and keeping a frozen SETTINGS made the
      // mock silently ignore every settings change — so a flow that depends on
      // one (Ask via the builtin model rather than the CLI, say) could not be
      // exercised at all, and a test that tried looked like the FEATURE was
      // broken. The payload key is `value` (ipc.setSettings) — reading the
      // wrong key here reproduces exactly that silent no-op.
      Object.assign(SETTINGS, args.value ?? {});
      return Promise.resolve(null);
    case "write_settings_export":
      // In-memory only (no real fs in mock mode) — just enough for the
      // export/import round trip to be exercisable in the mock.
      lastSettingsExport = String(args.contents ?? "");
      return Promise.resolve(null);
    case "read_settings_import":
      return Promise.resolve(lastSettingsExport ?? '{"schemaVersion":1}');
    case "set_provider_key":
    case "delete_provider_key":
    case "open_external":
      return Promise.resolve(null);
    case "create_file": {
      // Echo the real path back so the create-note flow routes to the note the
      // user actually named, holding what vault.rs wiki_page_stub seeds — not
      // read_file's sample body, so a new note opens empty as it really does.
      const path = `${String(args.parent)}/${String(args.name)}`;
      if (!mockNotes.has(path)) {
        const title = String(args.name).replace(/\.md$/, "").replace(/[-_]/g, " ");
        mockNotes.set(
          path,
          `---\ntype: concept\ntags:\ncreated: ${today()}\nconfidence: medium\nstatus: active\n---\n\n# ${title}\n`,
        );
      }
      return Promise.resolve(path);
    }
    case "create_folder":
      return Promise.resolve(`${VAULT}/wiki/new.md`);
    case "rename_path": {
      // Land on the name asked for, carrying a written note's text along, so a
      // rename opens the note it named (the tree stays the fixed fixture).
      const from = String(args.from);
      const to = `${from.slice(0, from.lastIndexOf("/"))}/${String(args.toName)}`;
      const error = protectedMutation(from) ?? protectedMutation(to);
      if (error) return Promise.reject(error);
      const text = mockNotes.get(from);
      if (text !== undefined) {
        mockNotes.delete(from);
        mockNotes.set(to, text);
      }
      return Promise.resolve(to);
    }
    case "move_path": {
      const from = String(args.from);
      const error = protectedMutation(from) ?? protectedMutation(String(args.toDir), true);
      if (error) return Promise.reject(error);
      const to = `${String(args.toDir)}/${from.split("/").pop()}`;
      // Decks really move (Study's archive), and refuse to overwrite, like
      // vault::move_path; other paths stay the echo they always were.
      const deck = mockDecks.get(from);
      if (deck !== undefined) {
        if (mockDecks.has(to)) {
          return Promise.reject(new Error(`destination exists: ${to}`));
        }
        mockDecks.delete(from);
        mockDecks.set(to, deck);
      }
      return Promise.resolve(to);
    }
    case "save_favorites":
      mockFavorites = args.paths as string[];
      return Promise.resolve(null);
    // ---- event bus -------------------------------------------------------
    // @tauri-apps/api/event's listen()/unlisten() are themselves invokes, so
    // the mock has to answer them or every listener in the app silently never
    // fires — and the returned unlisten resolves to nothing, which is where the
    // stray rejection in a plain-browser run came from.
    case "plugin:dialog|open": {
      // The native file/folder picker. Return a fixed path so the picker-driven
      // flows (import a conversation, pick a vault) are exercisable in the mock;
      // a real dialog can't open headless anyway.
      const opts = (args.options ?? {}) as {
        directory?: boolean;
        filters?: { name: string }[];
      };
      // `/image` asks for images only (ipc.pickImageFile).
      if (opts.filters?.[0]?.name === "Images")
        return Promise.resolve("/tmp/picked-shot.png");
      return Promise.resolve(
        opts.directory ? `${VAULT}` : `${VAULT}/_inbox/picked-export.jsonl`,
      );
    }
    // The native save dialog. Same fixed-path stand-in as |open above —
    // without it the settings EXPORT half of the round trip never runs in
    // the mock, so an import there always read the empty fallback bundle.
    case "plugin:dialog|save":
      return Promise.resolve(`${VAULT}/myco-settings.json`);
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
    // emit() is an invoke too. The mock bus is per-window in the real app but
    // one bus here, which is exactly what makes the spotlight route checkable
    // in a browser: its ask event is answered below the same way the main
    // window answers it (lib/spotlight.ts), with a canned turn.
    case "plugin:event|emit": {
      const name = String(args.event ?? "");
      emitMock(name, args.payload);
      if (name === "myco://spotlight-ask") {
        const question = String(args.payload ?? "");
        // A question no sample note mentions abstains, as the main window's
        // extractive path would (same token match as semantic_search below).
        const terms = question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
        const known = NODES.some((d) => {
          const hay = `${d.n} ${body(d)}`.toLowerCase();
          return terms.some((w) => hay.includes(w));
        });
        void sleep(600).then(() =>
          emitMock(
            "myco://spotlight-answer",
            known
              ? {
                  question,
                  answer: MOCK_SPOTLIGHT_ANSWER,
                  extractive: true,
                  relevance: MOCK_SPOTLIGHT_RELEVANCE,
                }
              : { question, answer: "", abstained: true },
          ),
        );
      }
      return Promise.resolve(undefined);
    }
    case "plugin:event|unlisten": {
      const name = String(args.event ?? "");
      const id = Number(args.eventId);
      const list = mockListeners.get(name);
      if (list)
        mockListeners.set(
          name,
          list.filter((l) => l.id !== id),
        );
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
      const req = (args.request ?? {}) as {
        provider_id?: string;
        model?: string;
      };
      return Promise.resolve({
        provider_id: req.provider_id ?? "anthropic-api",
        model: req.model ?? "mock-model",
        content:
          "(mock) provider reply — the real app calls the HTTP provider here.",
        usage: { input_tokens: 120, output_tokens: 42 },
      });
    }
    case "mcp_info":
      return Promise.resolve({
        running: true,
        url: "http://localhost:22360/mcp",
        command:
          'claude mcp add --transport http myco http://localhost:22360/mcp --header "Authorization: Bearer 0123456789abcdef0123456789abcdef"',
        desktop_json:
          '{\n  "mcpServers": {\n    "myco": {\n      "url": "http://localhost:22360/mcp",\n      "headers": { "Authorization": "Bearer 0123456789abcdef0123456789abcdef" }\n    }\n  }\n}',
      });
    case "mcp_connect":
      return Promise.resolve(
        "(mock) Connected myco over HTTP at http://localhost:22360/mcp",
      );
    // Today's inflow for the activity popover / tray panel. Plausible spread:
    // activity clustered in the hours up to "now" so the sparkbar always has
    // visible bars near the right edge of today, whatever the wall clock.
    case "save_dashboard":
      // Mock vault: the board just doesn't persist across reloads.
      return Promise.resolve(null);
    case "list_dashboards":
      return Promise.resolve(["overview"]);
    case "delete_dashboard":
      return Promise.resolve(null);
    // Saved Views round-trip through mockNotes, which read_file serves.
    case "save_view":
      mockNotes.set(
        `${VAULT}/.myco/views/${String(args.name)}.json`,
        String(args.content),
      );
      return Promise.resolve(null);
    case "list_views": {
      const prefix = `${VAULT}/.myco/views/`;
      return Promise.resolve(
        [...mockNotes.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length, -".json".length))
          .sort(),
      );
    }
    case "delete_view":
      mockNotes.delete(`${VAULT}/.myco/views/${String(args.name)}.json`);
      return Promise.resolve(null);
    // Plugin manifests live in mockNotes as `.myco/plugins/<dir>/manifest.json`.
    case "list_plugins": {
      const re = /^\/myco\/\.myco\/plugins\/([^/]+)\/manifest\.json$/;
      return Promise.resolve(
        [...mockNotes]
          .flatMap(([path, raw]) => {
            const m = re.exec(path);
            return m ? [{ dir: m[1], raw, error: null }] : [];
          })
          .sort((a, b) => (a.dir < b.dir ? -1 : 1)),
      );
    }
    case "inflow_daily": {
      // Deterministic-ish seeded ledger so the board's inflow charts render
      // in the mock browser: activity clusters on recent weekdays.
      const days = (args as { days?: number }).days ?? 30;
      const out = [];
      const now = Date.now();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now - i * 86_400_000);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const wk = d.getDay() === 0 || d.getDay() === 6;
        const wave = i > 45 ? 0 : (i * 7) % 5; // ledger "starts" 45 days ago
        out.push({
          day,
          mcp: wk ? 0 : wave,
          clipper: wk ? 1 : (i % 3 === 0 ? 2 : 0),
          voice: i % 5 === 0 ? 1 : 0,
          import: i % 11 === 0 ? 14 : 0,
        });
      }
      return Promise.resolve(out);
    }
    case "inflow_stats": {
      const h = new Date().getHours();
      const hourlyFiles = Array<number>(24).fill(0);
      const hourlyMcp = Array<number>(24).fill(0);
      const files = [2, 1, 0, 1, 2, 1]; // now, -1h, -2h, …
      const mcp = [3, 4, 2, 0, 5, 3];
      for (let back = 0; back < files.length; back++) {
        const hour = h - back;
        if (hour < 0) break; // earlier hours were "yesterday" — not today's bar
        hourlyFiles[hour] = files[back];
        hourlyMcp[hour] = mcp[back];
      }
      // hourlyFiles buckets sessions AND inbox files, so the two counts must
      // sum to its total — same invariant the real collector keeps.
      const filesTotal = hourlyFiles.reduce((a, b) => a + b, 0);
      const inboxToday = Math.min(3, filesTotal);
      return Promise.resolve({
        sessionsToday: filesTotal - inboxToday,
        inboxToday,
        // Split by frontmatter `source:`, so the mock must also sum to
        // inboxToday — and must include an unstamped file, since that is what
        // the breakdown has to survive in a real vault.
        inboxBySource:
          inboxToday > 0 ? { clipper: inboxToday - 1, unknown: 1 } : {},
        mcpCallsToday: hourlyMcp.reduce((a, b) => a + b, 0),
        mcpTopTool: "search",
        hourlyFiles,
        hourlyMcp,
      });
    }
    // ROADMAP P2 — crash report viewer. One mocked entry (Hangul message,
    // matching the real crash it was built to diagnose) so the About screen
    // has something to show under ?mock=1.
    case "recent_panics":
      return Promise.resolve([
        {
          unix_secs: Math.floor(Date.now() / 1000) - 3600,
          location: "src/vault.rs:88:15",
          message:
            "byte index 5 is not a char boundary; it is inside '한' (bytes 3..6) of `제목한글텍스트`",
          raw: "[unix 1755000000] panic at src/vault.rs:88:15: byte index 5 is not a char boundary; it is inside '한' (bytes 3..6) of `제목한글텍스트`",
        },
      ]);
    case "clear_panic_log":
      return Promise.resolve(null);
    case "os_version":
      return Promise.resolve("macOS 14.5 (mock)");
    // Harvest queue (Overview) — the ranked sessions plus the buckets the
    // ranker refused. Copies already harvested drop out of `items` so the
    // queue shrinks after a run, the way the real ledger makes it.
    case "harvest_candidates": {
      if (args.vaultPath && args.vaultPath !== VAULT) return Promise.reject(new Error("the active vault changed"));
      const limit = Number(args.limit ?? 20);
      const items = MOCK_HARVEST.filter((c) => !mockHarvested.has(c.path));
      return Promise.resolve({
        read_status: "complete",
        read_issues: [],
        items: items.slice(0, limit),
        excluded: {
          ...MOCK_HARVEST_EXCLUDED,
          already_harvested: mockHarvestedBefore + mockHarvested.size,
        },
        total_scanned: 1473,
        distinct_bodies: 719,
        eligible: items.length,
      });
    }
    case "harvest_run": {
      if (args.vaultPath && args.vaultPath !== VAULT) return Promise.reject(new Error("the active vault changed"));
      // COPY into the mock inbox (never touch the "original"), so the inbox
      // pass that follows has something real to ingest.
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      const inbox_rels: string[] = [];
      const skipped: { path: string; reason: string }[] = [];
      for (const p of paths) {
        const c = MOCK_HARVEST.find((x) => x.path === p);
        if (!c || mockHarvested.has(p)) {
          skipped.push({ path: p, reason: c ? "already harvested" : "not a candidate" });
          continue;
        }
        const name = p.split("/").pop() ?? "session.md";
        const target = `${VAULT}/_inbox/${name}`;
        if (!mockInbox.has(target)) mockInbox.set(target, mockHarvestBody(c));
        mockHarvestCopies.set(target, p);
        inbox_rels.push(`_inbox/${name}`);
      }
      return Promise.resolve({ copied: inbox_rels.length, inbox_rels, skipped });
    }
    // Judgement stage (Ingest): distill.rs's junk floor (200 B) and the
    // ledger fingerprint as real rules, then a LOW mock-only "log" floor
    // (600 B, the real one is Rust's) so all three verdicts are reachable by
    // pasting more or less text under ?mock=1 without needing 8 KB of it.
    case "judge_source": {
      const text = String(args.text ?? "");
      const bytes = Number(args.sizeBytes ?? text.length);
      if (bytes < 200) {
        return Promise.resolve({
          verdict: "drop",
          reason: `${bytes} B < 200 B`,
          rule: "junk_reason::min_bytes",
        });
      }
      if (/\[\[TASK_DONE\]\]/.test(text) && bytes < 1100) {
        return Promise.resolve({
          verdict: "drop",
          reason: "duplicate body (fingerprint seen 269×)",
          rule: "ledger::fingerprint",
        });
      }
      if (bytes < 600) {
        return Promise.resolve({
          verdict: "log",
          reason: `${bytes} B — below the wikify floor`,
          rule: "backfill::MIN_BYTES",
        });
      }
      return Promise.resolve({
        verdict: "harvest",
        reason: `${(bytes / 1024).toFixed(1)} KB of prose`,
        rule: "judge::pass",
      });
    }
    case "record_noop":
      mockNoops.push({ rel: String(args.rel ?? ""), reason: String(args.reason ?? "") });
      return Promise.resolve(undefined);
    default:
      // Reject, like the real Tauri does for a command that is not registered.
      // Resolving `undefined` instead is how the mock hid a broken feature for
      // as long as it did: ingest called claude_run_stream, got undefined back,
      // and died on `res.status` with a TypeError that read like an app bug —
      // in the mock every E2E suite runs against. A command that reaches here
      // is either a typo or an unmocked command, and both should be loud.
      return Promise.reject(
        new Error(
          `devMock: no handler for command "${cmd}" — add one in devMock.ts`,
        ),
      );
  }
}

/// Sources waiting in `_inbox/`, keyed by path. The clipper drops files here and
/// auto-ingest consumes them, so the mock has to model it as state rather than a
/// fixed listing — otherwise `runInboxPass` always finds an empty inbox and the
/// whole handoff is untestable.
const mockInbox = new Map<string, string>();

// Seed two pending sources so PageIngest's "waiting in _inbox" list (where the
// inflow "View →" lands) has rows in ?mock=1 — one from today, one older.
mockInbox.set(
  `${VAULT}/_inbox/clipped-rope-scaling.md`,
  '---\nsource: clipper\nurl: "https://example.com/rope"\ntitle: "RoPE scaling notes"\ncreated: 1755000000\nclipped: 1755000000\n---\n\n# RoPE scaling notes\n\nClipped article about rotary embeddings.\n',
);
mockInbox.set(
  `${VAULT}/_inbox/meeting-notes.md`,
  "# Meeting notes\n\nRaw notes waiting to be ingested.\n",
);

/// Notes written through `write_file`, so the task page's add/toggle round-trip
/// is exercisable in mock mode: without this a write was dropped and the next
/// scan returned the same seeded list, making a working feature look broken.
const mockNotes = new Map<string, string>();

// Tidy fixtures (app/docs/specs/2026-09-28-tidy-and-graph-rails.md): two
// imported session transcripts, and the summaries the pre-fix extractive
// ingest wrote of them — `Source: <stem>` titles, `## Related` links to
// transcript stems that resolve to nothing in wiki/ (one of them a session
// nobody summarised). The real vault's gaps rail, in miniature.
const MOCK_SESSION_A = "claude-code-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const MOCK_SESSION_B = "codex-019e2b7c-4d1a-7c3e-9f5b-2a8d6c4e1f07";
const MOCK_SESSION_UNSUMMARISED = "claude-code-e4649b3c-c5ca-4d83-a0a7-e2f41c540fe6";
const MOCK_SESSION_STEMS = [MOCK_SESSION_A, MOCK_SESSION_B];
const mockSessionPath = (s: string): string => `${VAULT}/sessions/2026-09/${s}.md`;
const mockSummaryPath = (s: string): string => `${VAULT}/wiki/source-${s}.md`;

function mockTranscript(stem: string, created: number, ask: string, reply: string): string {
  const [, source, id] = /^(claude-code|codex)-(.+)$/.exec(stem) ?? [];
  return (
    `---\nsource: ${source}\nconversation_id: ${id}\ncreated: ${created}\n---\n\n` +
    `# ${ask}\n\n**User:**\n\n${ask}\n\n**Assistant:**\n\n${reply}\n`
  );
}

function mockOpaqueSummary(stem: string, quote: string, related: string[]): string {
  return (
    `---\ntitle: "Source: ${stem}"\ntype: source-summary\ntags:\n  - source-summary\n` +
    `created: 2026-09-20\nlast_updated: 2026-09-20\nsource_count: 1\nconfidence: low\n` +
    `status: active\n---\n\n# Source: ${stem}\n\n` +
    `_발췌 요약 — 아래 문장은 모두 \`raw/${stem}.md\`에서 그대로 인용한 것입니다._\n\n` +
    `- ${quote} [^src-${stem}]\n\n## Related\n\n` +
    related.map((r) => `- [[${r}]]\n`).join("") +
    `\n[^src-${stem}]: [[source-${stem}]]\n`
  );
}

mockNotes.set(
  mockSessionPath(MOCK_SESSION_A),
  mockTranscript(
    MOCK_SESSION_A,
    1789182000,
    "서버 띄워봐.",
    "The dev server is up on port 5620; the graph page renders the mock vault.",
  ),
);
mockNotes.set(
  mockSessionPath(MOCK_SESSION_B),
  mockTranscript(
    MOCK_SESSION_B,
    1789797600,
    "그래프 범례를 접을 수 있게 해줘",
    "The legend rail now collapses to a thin edge tab and the canvas takes the freed width.",
  ),
);
mockNotes.set(
  mockSummaryPath(MOCK_SESSION_A),
  mockOpaqueSummary(
    MOCK_SESSION_A,
    "The dev server is up on port 5620; the graph page renders the mock vault.",
    [MOCK_SESSION_B, MOCK_SESSION_UNSUMMARISED],
  ),
);
mockNotes.set(
  mockSummaryPath(MOCK_SESSION_B),
  mockOpaqueSummary(
    MOCK_SESSION_B,
    "The legend rail now collapses to a thin edge tab and the canvas takes the freed width.",
    ["attention-mechanism", MOCK_SESSION_A],
  ),
);

/// Starred paths (vault-relative) as `save_favorites` last wrote them; served
/// back by `read_file` of `.myco/favorites.json` so a star survives a vault reopen.
let mockFavorites: string[] = [];

// Seed one note with due-dated tasks (one overdue, one due today) so the Topbar
// activity popover's due block has rows in mock mode — and, because read_file
// serves mockNotes, checking one off actually round-trips through
// writeTaskStatus's line rewrite instead of hitting the stale guard.
const day = (n: number): string => today(new Date(Date.now() + n * 86_400_000));
// The rich concept note behind the seeded attention-mechanism deck.
mockNotes.set(pathOf("attention-mechanism"), STUDY_NOTE);
// A `slash:` template: `/meeting` (`/회의록`) in the editor inserts its body.
// No `- [ ]` lines — tasksFromMockNotes would list them as tasks.
mockNotes.set(
  `${VAULT}/templates/회의록.md`,
  [
    "---",
    "slash: meeting",
    "slash_label: 회의록",
    "---",
    "",
    "## {{title}} — {{date}} {{time}}",
    "",
    "**참석자:** ${}",
    "",
    "### 안건",
    "- ",
    "",
    "### 결정",
    "- ",
    "",
  ].join("\n"),
);
// Two declarative plugins (lib/plugins.ts), off until the vault is trusted
// in Settings → Plugins: one valid (a template and a fence item; ```graph
// drawn by builtin:mermaid, ```dataview as code), one the guard refuses.
mockNotes.set(
  `${VAULT}/.myco/plugins/meeting-kit/manifest.json`,
  JSON.stringify(
    {
      id: "meeting-kit",
      name: "회의 키트",
      version: "1.0.0",
      contributes: {
        slash: [
          {
            label: "agenda",
            detail: "회의 안건",
            template: "### 안건\n- ${}\n\n### 결정\n- ",
          },
          { label: "graph", detail: "그래프 블록", fence: "graph" },
        ],
        fences: [
          { lang: "graph", renderer: "builtin:mermaid" },
          { lang: "dataview", renderer: "builtin:code" },
        ],
      },
    },
    null,
    2,
  ),
);
mockNotes.set(
  `${VAULT}/.myco/plugins/web-embed/manifest.json`,
  JSON.stringify({
    id: "web-embed",
    name: "Web embed",
    version: "0.1.0",
    contributes: { fences: [{ lang: "iframe", renderer: "builtin:iframe" }] },
  }),
);
// A code plugin (stage 6, lib/pluginSandbox): main.js runs in a worker once
// its two calls are allowed in Settings → Plugins. `/wordcount` counts the
// words selected, or with none (the `/` command leaves none) those on the
// caret's line, and inserts the count at the caret.
mockNotes.set(
  `${VAULT}/.myco/plugins/word-count/manifest.json`,
  JSON.stringify(
    {
      id: "word-count",
      name: "단어 수",
      version: "1.0.0",
      permissions: ["editor.selection", "editor.insertAtCursor"],
      contributes: {
        slash: [
          { label: "wordcount", detail: "단어 수 세기", command: "count" },
        ],
      },
    },
    null,
    2,
  ),
);
mockNotes.set(
  `${VAULT}/.myco/plugins/word-count/main.js`,
  [
    'myco.command("count", async () => {',
    "  const { text, line } = await myco.editor.selection();",
    "  const words = (text || line).split(/\\s+/).filter(Boolean).length;",
    "  await myco.editor.insertAtCursor(`(단어 ${words}개)`);",
    "});",
    "",
  ].join("\n"),
);
// A roadmap page (wiki/roadmaps/) so the Roadmap tab, the composer's target
// picker and MCP task tools have something real to bite on in mock mode.
mockNotes.set(
  `${VAULT}/wiki/roadmaps/memex-q4.md`,
  [
    "---",
    'title: "memex Q4"',
    "type: overview",
    "source_type: primary",
    "confidence: high",
    "status: active",
    "---",
    "",
    "# memex Q4 로드맵",
    "",
    "## M1 — trust",
    "- [x] reader badge #dev [[attention-mechanism]] ✅ 2026-08-20",
    `- [ ] provenance panel #dev 📅 ${day(9)}`,
    "",
    "## M2 — resurface",
    "- [ ] reunion tuning #research",
    "",
  ].join("\n"),
);
mockNotes.set(
  `${VAULT}/daily/tasks.md`,
  [
    "# tasks",
    "",
    // The legacy `@due` dialect, still read: one overdue, one due today.
    `- [ ] prepare the demo vault @${day(-1)}`,
    `- [ ] add the flash-attention variant @${day(0)}`,
    // Scheduling fields, so the calendar has bars to lay out and the detail
    // panel has something in every field: a multi-day bar, a scheduled dot, an
    // open-ended start, and four bars sharing days to push one into `+N`.
    `- [/] rewrite the ingest guide 🛫 ${day(-2)} 📅 ${day(4)} ⏱ 1w !p1`,
    `- [ ] reindex the demo vault ⏳ ${day(1)} 📅 ${day(2)}`,
    `- [ ] read the retrieval survey 🛫 ${day(0)} ⏱ 2d`,
    `- [ ] draft the release notes 🛫 ${day(1)} 📅 ${day(3)}`,
    `- [ ] chase the signing certificate 🛫 ${day(1)} 📅 ${day(3)} !p2`,
    `- [ ] tidy the screenshots 🛫 ${day(1)} 📅 ${day(3)} 🔁 every week`,
    "",
  ].join("\n"),
);

/// Checkbox lines in a written note, in the shape scan_tasks returns.
function tasksFromMockNotes(): {
  page: string;
  stem: string;
  line: number;
  text: string;
  done: boolean;
  status: "todo" | "doing" | "blocked" | "done";
}[] {
  const out: ReturnType<typeof tasksFromMockNotes> = [];
  for (const [path, content] of mockNotes) {
    const rel = path.replace(/^.*?\/(daily|wiki)\//, "$1/");
    const stem = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    content.split("\n").forEach((raw, i) => {
      const m = /^\s*[-*+]\s*\[([ xX/-])\]\s*(.*)$/.exec(raw);
      if (m) {
        const mark = m[1];
        const status =
          mark === "/"
            ? "doing"
            : mark === "-"
              ? "blocked"
              : /[xX]/.test(mark)
                ? "done"
                : "todo";
        out.push({
          page: rel,
          stem,
          line: i + 1,
          text: m[2],
          done: status === "done",
          status,
        });
      }
    });
  }
  return out;
}

/// Drop a clip into `_inbox/` and fire the deep-link handler's
/// `myco://clip-saved`, the same path the real Tauri event takes into the app.
/// Exported for the clip E2E: a deep link cannot be delivered to a browser.
export function emitClipSaved(title = "clipped-article"): void {
  // Long enough to pass the mock judge's floors — a clip that gets refused
  // exercises the judgement path, not the clip → pass handoff this seeds.
  mockInbox.set(
    `${VAULT}/_inbox/${title}.md`,
    `---\nsource: clipper\nurl: "https://example.com/article"\ntitle: "${title}"\ncreated: 1755000000\nclipped: 1755000000\n---\n\n# ${title}\n\nClipped selection about attention and transformers. ` +
      "Scaled dot-product attention computes a weighted sum of value vectors, where the weights come from the softmax of query–key dot products divided by the square root of the key dimension. " +
      "Multi-head attention runs several of these in parallel over learned projections and concatenates the results, which lets one layer attend to positional, syntactic and semantic relations at once. " +
      "Residual connections and layer normalization around each sublayer keep the deep stack trainable; positional encodings supply the order the attention itself ignores.\n",
  );
  emitMock("myco://clip-saved", { rel: `_inbox/${title}.md`, title });
}

export function installTauriMock(): void {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
  };
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) =>
      mockInvoke(cmd, args ?? {}),
    // The preview maps vault image paths through this; a browser has no asset
    // protocol, so the path passes through (and the image shows broken).
    convertFileSrc: (p: string) => p,
    // The real Tauri registers the callback and hands back an id; the mock
    // passes the function through, and `plugin:event|listen` above stores it.
    transformCallback: (cb: unknown) => cb,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
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
      if (list)
        mockListeners.set(
          event,
          list.filter((l) => l.id !== eventId),
        );
    },
  };
  // Test surface for the mock itself. Exposed from HERE, inside the module the
  // app actually loaded: a Playwright `evaluate` that dynamic-imports this file
  // gets a SECOND module instance with its own empty listener registry, so
  // anything it emits reaches nobody.
  (window as unknown as { __mycoMock?: unknown }).__mycoMock = {
    emit: emitMock,
    clip: emitClipSaved,
    inbox: () => [...mockInbox.keys()],
    /// Judgement-log lines written by record_noop (drop / all-NOOP endings).
    noops: () => [...mockNoops],
    /// Patch the mock's settings. The Settings UI cannot reach every
    /// combination — its provider picker only lists ENABLED providers, so a
    /// vault configured for the CLI cannot be switched to the builtin model
    /// through the UI at all, and a flow that only runs on the non-tool path
    /// (Ask's staged status) is otherwise unreachable from a test.
    settings: (patch: Record<string, unknown>) =>
      Object.assign(SETTINGS, patch),
    /// Pretend the index holds `n` pages (0 = never built).
    indexedPages: (n: number) => {
      mockIndexedPages = n;
    },
    /// Pretend `n` sessions were harvested before this session — the only way
    /// to reach the Overview's collapsed (mid-harvest) queue in the mock.
    harvestedBefore: (n: number) => {
      mockHarvestedBefore = n;
    },
  };
  console.info(
    "[devMock] Tauri IPC mock installed with",
    NODES.length,
    "sample nodes",
  );
}

// --- Harvest queue fixtures (harvest_candidates / harvest_run) ---------------
// Twelve sessions shaped like the owner's vault: dated stems, 8–200 KB, the
// nearest mock wiki page as the cluster, and an opening exchange so the queue
// rows have something to preview. The aggregate buckets are the MEASURED
// numbers from that vault (1,473 files → 719 distinct bodies), not invented.

const MOCK_HARVEST_EXCLUDED = {
  duplicate: 754,
  boilerplate: 60,
  too_small: 1231,
  too_large: 3,
  already_harvested: 0,
};

/** Paths harvested this browser session — they leave the queue for good. */
const mockHarvested = new Set<string>();
const mockHarvestCopies = new Map<string, string>();

/** Full synthetic transcripts exercise bounded passes, rather than tiny previews. */
function mockHarvestBody(row: { title: string; preview: string[]; size_bytes: number }): string {
  let body = `# ${row.title}\n\n${row.preview.join("\n")}\n`;
  for (let block = 1; body.length < row.size_bytes; block++) {
    body += `\nUser: Synthetic session evidence block ${block}. ${row.preview.join(" ")}\n`;
  }
  return body;
}
/** Runs from BEFORE this session (`__mycoMock.harvestedBefore`). A vault
 *  mid-harvest is otherwise unreachable in the mock: the Overview collapses
 *  the queue once anything has ever been harvested, and a fresh mock has not. */
let mockHarvestedBefore = 0;
/** Judgement log lines (`record_noop`) — inspectable from a test. */
const mockNoops: { rel: string; reason: string }[] = [];

function harvestRow(
  day: string,
  stem: string,
  kb: number,
  cluster: string,
  score: number,
  cites: number,
  preview: string[],
): {
  path: string;
  rel: string;
  size_bytes: number;
  mtime: number;
  title: string;
  preview: string[];
  cluster: { page: string; score: number } | null;
  est_citations: number;
  kind: "session" | "raw";
} {
  const name = `${day}-${stem}.md`;
  return {
    path: `${VAULT}/sessions/2026-08/${name}`,
    rel: `sessions/2026-08/${name}`,
    size_bytes: Math.round(kb * 1024),
    mtime: Math.floor(new Date(`${day}T10:00:00`).getTime() / 1000),
    title: `${day}-${stem}`,
    preview,
    cluster: { page: `wiki/${cluster}.md`, score },
    est_citations: cites,
    kind: "session",
  };
}

const MOCK_HARVEST = [
  harvestRow("2026-08-29", "rerank-thresholds", 42.1, "analysis-rlhf-vs-dpo", 0.81, 4, [
    "[User] Lowering the relevance floor to 0.50 raises recall but drags wrong answers up with it.",
    "[lead] Measured the two floors separately: intent 0.65 / relevance 0.50 gives top-5 precision 0.72.",
    "[User] Then strip every place that used the RRF score as a confidence.",
    "[lead] Score is a rank, not a certainty. The label copy changes too.",
  ]),
  harvestRow("2026-08-27", "vector-store-choice", 18.4, "vector-database", 0.74, 3, [
    "[User] Should we add LanceDB? The chunk count keeps growing.",
    "[lead] Brute force is 12 ms on the current corpus. An index build, a dependency and a format lock buy nothing yet.",
    "[User] When do we switch?",
    "[lead] Past 100 ms per query. Until then reusing SEED is enough.",
  ]),
  harvestRow("2026-08-25", "galaxy-clustering", 96.7, "transformer-architecture", 0.69, 5, [
    "[User] The graph reads as one blob, especially on the demo vault.",
    "[lead] Subfolder-first with a Louvain fallback splits it into 71 topics.",
    "[User] Colours? One hue per galaxy, shades for the rest.",
  ]),
  harvestRow("2026-08-24", "citation-format", 11.2, "source-constitutional-ai-paper", 0.77, 2, [
    "[User] Pin the citation anchor to [^src-…]; the formats are all over the place.",
    "[lead] One regex in the parser. The existing nine citations pass through untouched.",
    "[User] Good. Put it in the docs as well.",
  ]),
  harvestRow("2026-08-22", "session-backfill-design", 63.5, "analysis-scaling-vs-data", 0.66, 3, [
    "[User] 1,400 sessions and not one reached the wiki — auto-ingest only watches _inbox.",
    "[lead] Promotion it is: sessions/ stays a read-only archive, only copies enter the queue.",
    "[User] Is filtering by size fine? 990 of them are under 2 KB.",
    "[lead] 8 KB floor, 200 KB ceiling. Anything above is held, not thrown away.",
  ]),
  harvestRow("2026-08-20", "tokenizer-notes", 24.9, "byte-pair-encoding", 0.83, 4, [
    "[User] Why does the BPE merge order change the result?",
    "[lead] Merges are greedy, so an earlier merge changes the counts of later candidates. Order IS the vocabulary.",
    "[User] Leave one example — it goes in the wiki.",
  ]),
  harvestRow("2026-08-19", "attention-heads", 15.8, "multi-head-attention", 0.86, 2, [
    "[User] Do the heads actually attend to different things?",
    "[lead] The attention maps split into positional-bias heads and syntactic heads, but it varies by layer.",
    "[User] Record the observation, not a claim.",
  ]),
  harvestRow("2026-08-18", "notch-voice-capture", 38.0, "tool-use", 0.61, 3, [
    "[User] I want to record from the notch and drop straight into the vault.",
    "[lead] Capture → whisper → raw/voice-*.md. raw/ is immutable, so the summary is a separate file.",
    "[User] And on failure? Don't die quietly — leave it in the tray.",
  ]),
  harvestRow("2026-08-16", "immutable-raw", 9.6, "source-attention-is-all-you-need", 0.58, 2, [
    "[User] If an agent edits raw/, the original is gone.",
    "[lead] The read-only rule goes on all three paths: app, MCP, agents.",
    "[User] Write the rule into CLAUDE.md too.",
  ]),
  harvestRow("2026-08-14", "distill-empty-runs", 51.3, "distillation", 0.72, 3, [
    "[User] Distill ran 97 times and the manifests are nearly empty.",
    "[lead] Sessions score as Summary tier, and the Summary stage structurally excludes sessions/.",
    "[User] So the tier isn't the problem — the stage filter is.",
  ]),
  harvestRow("2026-08-12", "graph-render-loop", 12.7, "inference-optimization", 0.55, 2, [
    "[User] Can't we stop the render loop when nothing moves?",
    "[lead] The animation is the requirement. A living galaxy is the point, so idling is a feature removal.",
    "[User] Then pin it down in a comment.",
  ]),
  harvestRow("2026-08-10", "answer-grounding", 28.4, "rag", 0.79, 3, [
    "[User] The answers sound plausible but cite nothing.",
    "[lead] Going extractive: quote the note verbatim, and say so when there is nothing to quote.",
    "[User] When there's no evidence, say 'no evidence' instead of staying silent.",
  ]),
];
