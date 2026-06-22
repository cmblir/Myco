// Sample data for non-backed pages (Ingest pipeline, Query LLM, History,
// Provenance). These will be replaced with real backend wiring as features
// land; for now they preserve the design's visual fidelity.

export type PageType =
  | "overview"
  | "source"
  | "entity"
  | "concept"
  | "technique"
  | "analysis";

export interface SamplePage {
  id: string;
  title: string;
  type: PageType;
  folder: string;
  updated: string;
  sources: number;
  links: number;
  words: number;
}

export interface SampleProject {
  slug: string;
  title: string;
  glyph: string;
  pages: number;
  sources: number;
}

export interface SampleHistoryEntry {
  hash: string;
  date: string;
  source: string;
  created: number;
  modified: number;
}

export interface SampleProvenanceEntry {
  id: string;
  cited: number;
  total: number;
}

export interface SampleModel {
  id: string;
  provider: string;
  name: string;
  desc: string;
  ctx: string;
  speed: string;
  recommended: boolean;
}

export interface SampleProvider {
  id: string;
  name: string;
  kind: "cli" | "api" | "local";
  desc: string;
  connected: boolean;
  lastCheck?: string;
}

export const SAMPLE = {
  projects: [
    {
      slug: "karpathy",
      title: "Andrej Karpathy LLM Wiki",
      glyph: "K",
      pages: 19,
      sources: 3,
    },
    {
      slug: "ml-papers",
      title: "ML Papers",
      glyph: "M",
      pages: 42,
      sources: 12,
    },
    {
      slug: "personal",
      title: "Personal Notes",
      glyph: "P",
      pages: 8,
      sources: 2,
    },
  ] as SampleProject[],
  active: "karpathy",

  pages: [
    {
      id: "overview",
      title: "Overview",
      type: "overview",
      folder: "_root",
      updated: "2026-04-26",
      sources: 3,
      links: 12,
      words: 320,
    },
    {
      id: "index",
      title: "Index",
      type: "overview",
      folder: "_root",
      updated: "2026-04-26",
      sources: 0,
      links: 8,
      words: 96,
    },
    {
      id: "log",
      title: "Log",
      type: "overview",
      folder: "_root",
      updated: "2026-04-26",
      sources: 0,
      links: 4,
      words: 240,
    },
    {
      id: "src-bpe",
      title: "Source · BPE explainer",
      type: "source",
      folder: "sources",
      updated: "2026-04-24",
      sources: 0,
      links: 1,
      words: 1240,
    },
    {
      id: "src-gpt1",
      title: "Source · GPT-1 (2018)",
      type: "source",
      folder: "sources",
      updated: "2026-04-23",
      sources: 0,
      links: 1,
      words: 980,
    },
    {
      id: "src-nanochat",
      title: "Source · nanochat",
      type: "source",
      folder: "sources",
      updated: "2026-04-22",
      sources: 0,
      links: 1,
      words: 760,
    },
    {
      id: "andrej-karpathy",
      title: "Andrej Karpathy",
      type: "entity",
      folder: "entities",
      updated: "2026-04-24",
      sources: 2,
      links: 6,
      words: 380,
    },
    {
      id: "alec-radford",
      title: "Alec Radford",
      type: "entity",
      folder: "entities",
      updated: "2026-04-23",
      sources: 1,
      links: 3,
      words: 220,
    },
    {
      id: "openai",
      title: "OpenAI",
      type: "entity",
      folder: "entities",
      updated: "2026-04-23",
      sources: 2,
      links: 5,
      words: 310,
    },
    {
      id: "gpt-1",
      title: "GPT-1",
      type: "entity",
      folder: "entities",
      updated: "2026-04-23",
      sources: 1,
      links: 7,
      words: 540,
    },
    {
      id: "nanochat",
      title: "nanochat",
      type: "entity",
      folder: "entities",
      updated: "2026-04-22",
      sources: 1,
      links: 4,
      words: 360,
    },
    {
      id: "nanogpt",
      title: "nanoGPT",
      type: "entity",
      folder: "entities",
      updated: "2026-04-22",
      sources: 1,
      links: 3,
      words: 200,
    },
    {
      id: "bookcorpus",
      title: "BookCorpus",
      type: "entity",
      folder: "entities",
      updated: "2026-04-23",
      sources: 1,
      links: 2,
      words: 140,
    },
    {
      id: "llm-pipeline",
      title: "LLM training pipeline",
      type: "concept",
      folder: "concepts",
      updated: "2026-04-24",
      sources: 3,
      links: 9,
      words: 720,
    },
    {
      id: "pretrain-finetune",
      title: "Pretrain / finetune paradigm",
      type: "concept",
      folder: "concepts",
      updated: "2026-04-23",
      sources: 2,
      links: 5,
      words: 410,
    },
    {
      id: "bpe",
      title: "Byte Pair Encoding",
      type: "technique",
      folder: "techniques",
      updated: "2026-04-24",
      sources: 1,
      links: 5,
      words: 580,
    },
    {
      id: "midtraining",
      title: "Midtraining",
      type: "technique",
      folder: "techniques",
      updated: "2026-04-23",
      sources: 1,
      links: 3,
      words: 290,
    },
    {
      id: "transformer-decoder",
      title: "Transformer (decoder-only)",
      type: "technique",
      folder: "techniques",
      updated: "2026-04-23",
      sources: 2,
      links: 6,
      words: 640,
    },
    {
      id: "scaling-laws-vs-data",
      title: "Scaling laws vs data quality",
      type: "analysis",
      folder: "analyses",
      updated: "2026-04-24",
      sources: 2,
      links: 4,
      words: 470,
    },
  ] as SamplePage[],

  history: [
    {
      hash: "9a3f12c",
      date: "2026-04-26",
      source: "Wiki overview update",
      created: 0,
      modified: 3,
    },
    {
      hash: "2719a9b",
      date: "2026-04-24",
      source: "Byte Pair Encoding (BPE)",
      created: 4,
      modified: 5,
    },
    {
      hash: "c41ed02",
      date: "2026-04-23",
      source: "GPT-1 (Improving Language Understanding…)",
      created: 6,
      modified: 4,
    },
    {
      hash: "11a0b88",
      date: "2026-04-23",
      source: "nanochat — 100$ ChatGPT",
      created: 5,
      modified: 2,
    },
    {
      hash: "f0e2a51",
      date: "2026-04-22",
      source: "Wiki initialized",
      created: 3,
      modified: 0,
    },
  ] as SampleHistoryEntry[],

  provenance: [
    { id: "bpe", cited: 9, total: 11 },
    { id: "gpt-1", cited: 14, total: 16 },
    { id: "transformer-decoder", cited: 8, total: 12 },
    { id: "llm-pipeline", cited: 11, total: 18 },
    { id: "pretrain-finetune", cited: 6, total: 9 },
    { id: "midtraining", cited: 4, total: 8 },
    { id: "andrej-karpathy", cited: 5, total: 7 },
    { id: "openai", cited: 4, total: 6 },
    { id: "alec-radford", cited: 3, total: 5 },
    { id: "nanochat", cited: 3, total: 6 },
    { id: "nanogpt", cited: 2, total: 4 },
    { id: "bookcorpus", cited: 1, total: 3 },
    { id: "scaling-laws-vs-data", cited: 5, total: 10 },
  ] as SampleProvenanceEntry[],

  recentLog: [
    { date: "2026-04-26", action: "ingest", title: "Wiki overview refreshed" },
    { date: "2026-04-24", action: "ingest", title: "Byte Pair Encoding (BPE)" },
    {
      date: "2026-04-24",
      action: "query",
      title: "How does BPE merge tokens?",
    },
    { date: "2026-04-23", action: "ingest", title: "GPT-1 paper" },
    {
      date: "2026-04-23",
      action: "lint",
      title: "Lint pass — 2 fixes applied",
    },
    { date: "2026-04-22", action: "ingest", title: "nanochat" },
    { date: "2026-04-22", action: "maintenance", title: "Wiki initialized" },
  ] as { date: string; action: string; title: string }[],

  recentQueries: [
    { q: "How does BPE merge tokens?", wiki: 4, raw: 1 },
    { q: "Why did GPT-1 use only the decoder?", wiki: 3, raw: 1 },
    { q: "What is midtraining?", wiki: 2, raw: 0 },
  ] as { q: string; wiki: number; raw: number }[],

  sampleAnswer: `**Byte Pair Encoding (BPE)** is a subword tokenization technique that iteratively merges the most frequent adjacent byte pairs in a corpus.<cite n="1"/> It produces a fixed-size vocabulary that balances character-level fallback with word-level efficiency.<cite n="2"/>

The training loop:
1. Start with the byte alphabet (256 entries).
2. Count adjacent pair frequencies across the corpus.
3. Merge the most frequent pair into a new token.
4. Repeat until the desired vocab size is reached.

GPT-1 onwards adopted BPE because it gracefully handles unseen words by falling back to subword units, which removed the need for a fixed word-level vocabulary.<cite n="3"/>`,

  sampleCitations: [
    {
      n: 1,
      page: "bpe",
      excerpt: "BPE merges the most frequent adjacent pair iteratively.",
    },
    {
      n: 2,
      page: "bpe",
      excerpt: "Vocab size trades fallback granularity for sequence length.",
    },
    {
      n: 3,
      page: "gpt-1",
      excerpt: "GPT-1 adopted BPE for open-vocabulary modelling.",
    },
  ],

  graph: {
    nodes: [
      {
        id: "andrej-karpathy",
        group: "entity",
        label: "Andrej Karpathy",
        w: 6,
      },
      { id: "alec-radford", group: "entity", label: "Alec Radford", w: 4 },
      { id: "openai", group: "entity", label: "OpenAI", w: 5 },
      { id: "gpt-1", group: "entity", label: "GPT-1", w: 7 },
      { id: "nanochat", group: "entity", label: "nanochat", w: 5 },
      { id: "nanogpt", group: "entity", label: "nanoGPT", w: 4 },
      { id: "bookcorpus", group: "entity", label: "BookCorpus", w: 3 },
      { id: "llm-pipeline", group: "concept", label: "LLM pipeline", w: 8 },
      {
        id: "pretrain-finetune",
        group: "concept",
        label: "Pretrain/Finetune",
        w: 5,
      },
      { id: "bpe", group: "technique", label: "BPE", w: 7 },
      { id: "midtraining", group: "technique", label: "Midtraining", w: 4 },
      {
        id: "transformer-decoder",
        group: "technique",
        label: "Transformer",
        w: 7,
      },
      {
        id: "scaling-laws-vs-data",
        group: "analysis",
        label: "Scaling vs data",
        w: 4,
      },
      { id: "src-bpe", group: "source", label: "src · BPE", w: 3 },
      { id: "src-gpt1", group: "source", label: "src · GPT-1", w: 3 },
      { id: "src-nanochat", group: "source", label: "src · nanochat", w: 3 },
    ] as { id: string; group: PageType; label: string; w: number }[],
    edges: [
      ["src-bpe", "bpe"],
      ["src-gpt1", "gpt-1"],
      ["src-nanochat", "nanochat"],
      ["bpe", "gpt-1"],
      ["bpe", "transformer-decoder"],
      ["bpe", "llm-pipeline"],
      ["gpt-1", "openai"],
      ["gpt-1", "alec-radford"],
      ["gpt-1", "bookcorpus"],
      ["gpt-1", "transformer-decoder"],
      ["gpt-1", "pretrain-finetune"],
      ["nanochat", "andrej-karpathy"],
      ["nanogpt", "andrej-karpathy"],
      ["nanochat", "llm-pipeline"],
      ["nanogpt", "transformer-decoder"],
      ["midtraining", "llm-pipeline"],
      ["pretrain-finetune", "llm-pipeline"],
      ["transformer-decoder", "llm-pipeline"],
      ["scaling-laws-vs-data", "llm-pipeline"],
      ["scaling-laws-vs-data", "pretrain-finetune"],
      ["andrej-karpathy", "openai"],
      ["alec-radford", "openai"],
    ] as [string, string][],
  },

  pageContents: {
    overview: `# Overview\n\nThis wiki traces the evolution of LLMs through Andrej Karpathy's work, the GPT lineage, and the techniques that compose modern training pipelines.\n\n## Coverage\n\n- **GPT lineage** — from the 2018 GPT-1 two-stage paradigm to the full nanochat pipeline.\n- **Training pipeline** — tokenizer (BPE) → pretrain → midtraining → SFT → RL → deploy.\n- **Open-source tools** — nanochat, nanoGPT.\n- **People & orgs** — Andrej Karpathy, Alec Radford, OpenAI.\n\n## Getting started\n\n1. Drop a document into \`raw/\` (or paste in **Ingest**).\n2. Claude integrates it into the wiki, with inline citations.\n3. Browse the **Graph** to see connections grow.`,
    bpe: `# Byte Pair Encoding\n\nA subword tokenisation technique that iteratively merges the most frequent adjacent byte pairs.<cite n="1"/>\n\n## Why subwords?\n\nWord-level vocabularies suffer from out-of-vocabulary tokens; character-level models pay a heavy sequence-length cost. BPE strikes a middle ground.<cite n="2"/>\n\n## Training\n\n1. Start with byte alphabet.\n2. Count pair frequencies.\n3. Merge most frequent pair.\n4. Repeat to vocab size.\n\nGPT-1 onwards adopted BPE for open-vocabulary modelling.<cite n="3"/>`,
  } as Record<string, string>,

  models: [
    {
      id: "claude-opus-4-7",
      provider: "anthropic",
      name: "Claude Opus 4.7",
      desc: "Highest quality. Slowest.",
      ctx: "200k",
      speed: "slow",
      recommended: false,
    },
    {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      name: "Claude Sonnet 4.6",
      desc: "Balanced quality & speed.",
      ctx: "200k",
      speed: "medium",
      recommended: true,
    },
    {
      id: "claude-haiku-4-5",
      provider: "anthropic",
      name: "Claude Haiku 4.5",
      desc: "Fastest, lowest cost.",
      ctx: "200k",
      speed: "fast",
      recommended: false,
    },
    {
      id: "gpt-4o",
      provider: "openai",
      name: "GPT-4o",
      desc: "OpenAI flagship multimodal.",
      ctx: "128k",
      speed: "medium",
      recommended: false,
    },
    {
      id: "gpt-4o-mini",
      provider: "openai",
      name: "GPT-4o mini",
      desc: "Cheap & fast.",
      ctx: "128k",
      speed: "fast",
      recommended: false,
    },
    {
      id: "gemini-2-pro",
      provider: "google",
      name: "Gemini 2.0 Pro",
      desc: "Long-context Google model.",
      ctx: "1M",
      speed: "medium",
      recommended: false,
    },
    {
      id: "llama-3-70b",
      provider: "ollama",
      name: "Llama 3 70B (local)",
      desc: "Runs through local Ollama.",
      ctx: "32k",
      speed: "fast",
      recommended: false,
    },
  ] as SampleModel[],

  providers: [
    {
      id: "anthropic-cli",
      name: "Claude Code (CLI)",
      kind: "cli",
      desc: "Use your Claude Pro / Max subscription via the local CLI. No API key needed.",
      connected: true,
      lastCheck: "2 min ago",
    },
    {
      id: "anthropic-api",
      name: "Anthropic API",
      kind: "api",
      desc: "Direct API calls to claude.ai. Requires an API key from console.anthropic.com.",
      connected: false,
    },
    {
      id: "openai-api",
      name: "OpenAI API",
      kind: "api",
      desc: "Use GPT-4o / GPT-4o mini through the OpenAI API.",
      connected: false,
    },
    {
      id: "google-api",
      name: "Google AI",
      kind: "api",
      desc: "Gemini family via Google AI Studio.",
      connected: false,
    },
    {
      id: "ollama",
      name: "Ollama (local)",
      kind: "local",
      desc: "Run open-source models locally. Auto-detects http://localhost:11434.",
      connected: true,
      lastCheck: "live",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      kind: "api",
      desc: "One key for many providers. Useful for model comparison.",
      connected: false,
    },
  ] as SampleProvider[],

  stats: {
    pages: 19,
    sources: 3,
    links: 64,
    wikiRatio: 0.62,
    lastUpdated: "2026-04-26",
    started: "2026-04-22",
  },
};
