import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUDGET_KEY,
  BUDGET_THRESHOLD_KEY,
  DEFAULT_MONTHLY_THRESHOLD_USD,
  estimateCost,
  getBudgetThreshold,
  getUsage,
  overBudget,
  recordUsage,
  setBudgetThreshold,
} from "./budget";

// The unit-test env is node (no DOM), so stand in a minimal localStorage.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  (globalThis as { localStorage: unknown }).localStorage = new MemoryStorage();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("estimateCost", () => {
  it("computes per-1M-token cost for a known model", () => {
    // claude-opus-4-8: $5/1M in, $25/1M out.
    // 1M in + 1M out = 5 + 25 = 30.
    expect(estimateCost("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(
      30,
    );
    // 500k in, 200k out = 2.5 + 5 = 7.5
    expect(estimateCost("claude-opus-4-8", 500_000, 200_000)).toBeCloseTo(7.5);
  });

  it("resolves suffixed ids via longest-prefix match", () => {
    expect(estimateCost("claude-haiku-4-5-20251001", 1_000_000, 0)).toBeCloseTo(
      1,
    );
  });

  it("returns zero for unknown models", () => {
    expect(estimateCost("mystery-model", 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("recordUsage / getUsage", () => {
  it("accumulates tokens per model across calls", () => {
    recordUsage("gpt-4o", 1000, 500);
    recordUsage("gpt-4o", 2000, 1500);

    const usage = getUsage();
    const entry = usage.entries.find((e) => e.model === "gpt-4o");
    expect(entry).toBeDefined();
    expect(entry?.inTokens).toBe(3000);
    expect(entry?.outTokens).toBe(2000);
    // gpt-4o: $2.5/1M in, $10/1M out -> 3000*2.5/1e6 + 2000*10/1e6
    expect(entry?.costUsd).toBeCloseTo(0.0275);
  });

  it("sums cost across models into the total", () => {
    recordUsage("claude-opus-4-8", 1_000_000, 0); // $5
    recordUsage("claude-haiku-4-5", 1_000_000, 0); // $1
    expect(getUsage().totalUsd).toBeCloseTo(6);
  });

  it("persists through the BUDGET_KEY entry", () => {
    recordUsage("claude-opus-4-8", 100, 100);
    expect(localStorage.getItem(BUDGET_KEY)).not.toBeNull();
  });
});

describe("overBudget", () => {
  it("uses the default threshold when none is set", () => {
    expect(getBudgetThreshold()).toBe(DEFAULT_MONTHLY_THRESHOLD_USD);
    expect(overBudget()).toBe(false);
  });

  it("crosses the threshold as spend accumulates", () => {
    setBudgetThreshold(10);
    expect(localStorage.getItem(BUDGET_THRESHOLD_KEY)).toBe("10");

    // $5 of opus input — under $10.
    recordUsage("claude-opus-4-8", 1_000_000, 0);
    expect(overBudget()).toBe(false);

    // Another $5 (1M out * $25/1M = $25) pushes total to $30 >= $10.
    recordUsage("claude-opus-4-8", 0, 1_000_000);
    expect(overBudget()).toBe(true);
  });

  it("is true exactly at the threshold boundary", () => {
    setBudgetThreshold(5);
    recordUsage("claude-opus-4-8", 1_000_000, 0); // exactly $5
    expect(overBudget()).toBe(true);
  });
});
