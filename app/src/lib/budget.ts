// Token/cost budget guard. A rough public price table lets the app estimate
// cumulative spend across the HTTP providers and warn before a monthly
// threshold is crossed. Prices are USD per 1M tokens (input, output) and are
// approximate — this is a spend tripwire, not billing. Usage is tracked per
// calendar month in localStorage so the guard resets each cycle.

export interface ModelPrice {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

// Known model ids -> price. Lookup is longest-prefix (see priceFor) so dated or
// suffixed variants of a listed id resolve to the base price; anything unknown
// falls through to zero (no guard, no estimate). Anthropic prices are exact
// public list prices; OpenAI/Google are rough public figures.
const PRICES: Record<string, ModelPrice> = {
  // Anthropic claude-*
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  // OpenAI gpt-* (rough public $/1M)
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4-turbo": { in: 10, out: 30 },
  "gpt-4": { in: 30, out: 60 },
  "gpt-3.5-turbo": { in: 0.5, out: 1.5 },
  // Google gemini-* (rough public $/1M)
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
};

const ZERO: ModelPrice = { in: 0, out: 0 };

/** localStorage key for the cumulative per-month usage record. */
export const BUDGET_KEY = "memex.budget.usage.v1";
/** localStorage key for the configurable monthly spend threshold. */
export const BUDGET_THRESHOLD_KEY = "memex.budget.threshold.v1";
/** Default monthly spend threshold in USD. */
export const DEFAULT_MONTHLY_THRESHOLD_USD = 20;

export interface UsageEntry {
  model: string;
  inTokens: number;
  outTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  entries: UsageEntry[];
  totalUsd: number;
}

interface StoredUsage {
  /** YYYY-MM the record covers; a new month resets the tally. */
  month: string;
  models: Record<string, { inTokens: number; outTokens: number }>;
}

/** Price for a model id via longest-prefix match; unknown ids cost zero. */
function priceFor(model: string): ModelPrice {
  if (PRICES[model]) return PRICES[model];
  let best: ModelPrice | null = null;
  let bestLen = 0;
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = PRICES[key];
      bestLen = key.length;
    }
  }
  return best ?? ZERO;
}

/** Estimated cost in USD for a single call. Pure; unknown model -> 0. */
export function estimateCost(
  model: string,
  inTok: number,
  outTok: number,
): number {
  const p = priceFor(model);
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function readStore(): StoredUsage {
  const empty: StoredUsage = { month: currentMonth(), models: {} };
  try {
    const raw = localStorage.getItem(BUDGET_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredUsage>;
    // A record from a previous month is stale — start the new cycle at zero.
    if (parsed.month !== empty.month || typeof parsed.models !== "object") {
      return empty;
    }
    return { month: empty.month, models: parsed.models ?? {} };
  } catch {
    return empty;
  }
}

function writeStore(store: StoredUsage): void {
  try {
    localStorage.setItem(BUDGET_KEY, JSON.stringify(store));
  } catch {
    /* quota or disabled — best effort */
  }
}

/** Add a completed call's token counts to the current month's tally. */
export function recordUsage(
  model: string,
  inTok: number,
  outTok: number,
): void {
  const store = readStore();
  const prev = store.models[model] ?? { inTokens: 0, outTokens: 0 };
  store.models[model] = {
    inTokens: prev.inTokens + inTok,
    outTokens: prev.outTokens + outTok,
  };
  writeStore(store);
}

/** Per-model usage for the current month plus the summed cost. */
export function getUsage(): UsageSummary {
  const store = readStore();
  const entries: UsageEntry[] = Object.entries(store.models).map(
    ([model, t]) => ({
      model,
      inTokens: t.inTokens,
      outTokens: t.outTokens,
      costUsd: estimateCost(model, t.inTokens, t.outTokens),
    }),
  );
  const totalUsd = entries.reduce((sum, e) => sum + e.costUsd, 0);
  return { entries, totalUsd };
}

/** Configured monthly threshold in USD (falls back to the default). */
export function getBudgetThreshold(): number {
  try {
    const raw = localStorage.getItem(BUDGET_THRESHOLD_KEY);
    if (!raw) return DEFAULT_MONTHLY_THRESHOLD_USD;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_THRESHOLD_USD;
  } catch {
    return DEFAULT_MONTHLY_THRESHOLD_USD;
  }
}

/** Persist a new monthly threshold in USD. */
export function setBudgetThreshold(usd: number): void {
  try {
    localStorage.setItem(BUDGET_THRESHOLD_KEY, String(usd));
  } catch {
    /* quota or disabled — best effort */
  }
}

/** True once this month's estimated spend reaches the configured threshold. */
export function overBudget(): boolean {
  return getUsage().totalUsd >= getBudgetThreshold();
}
