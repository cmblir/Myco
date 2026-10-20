import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSettingsStore } from "../stores/settingsStore";
import type { MycoSettings } from "./ipc";
import {
  BUILTIN_CHAT_MODEL,
  BUILTIN_FAST_CHAT_MODEL,
  BUILTIN_INGEST_MODEL,
  BUILTIN_MODEL,
  CLI_DEFAULT,
  PROVIDERS,
  RECOMMENDED_MODEL,
  isRecommendedModel,
  isBuiltinChatModel,
  providerCanIngest,
  useEnabledProviders,
} from "./providers";

describe("local provider preparation", () => {
  function enabledNames(): string {
    function PickerProviders() {
      return createElement("span", null, useEnabledProviders().map((provider) => provider.id).join(","));
    }
    return renderToStaticMarkup(createElement(PickerProviders));
  }

  it("keeps local choices available before settings load without offering an external account", () => {
    const previous = useSettingsStore.getState().settings;
    try {
      useSettingsStore.setState({ settings: null });
      expect(enabledNames()).toBe("<span>builtin-local</span>");
    } finally {
      useSettingsStore.setState({ settings: previous });
    }
  });

  it("keeps local preparation available when all legacy connection flags are false", () => {
    const previous = useSettingsStore.getState().settings;
    try {
      useSettingsStore.setState({ settings: { providers: Object.fromEntries(PROVIDERS.map((provider) => [provider.flag, false])) } as MycoSettings });
      expect(enabledNames()).toBe("<span>builtin-local</span>");
    } finally {
      useSettingsStore.setState({ settings: previous });
    }
  });
});

describe("built-in provider selection", () => {
  it("defaults a provider-only choice to quote-only while keeping Qwen explicitly selectable", () => {
    const catalog = PROVIDERS.find((p) => p.id === "builtin-local")?.catalog;
    // ModelSelect persists the first catalog model when changing providers.
    // Choosing offline retrieval must not opt into an optional generator.
    expect(catalog?.[0]).toBe(BUILTIN_MODEL);
    expect(catalog).toContain(BUILTIN_CHAT_MODEL);
    expect(catalog).toContain(BUILTIN_FAST_CHAT_MODEL);
  });

  it("recognizes only pinned generators, separate from quote-only roles", () => {
    expect(isBuiltinChatModel(BUILTIN_CHAT_MODEL)).toBe(true);
    expect(isBuiltinChatModel(BUILTIN_FAST_CHAT_MODEL)).toBe(true);
    for (const model of [BUILTIN_MODEL, BUILTIN_INGEST_MODEL, "unknown", ""]) {
      expect(isBuiltinChatModel(model)).toBe(false);
    }
  });
});

// Regression guard for the Model-tab bug where a connected CLI provider's
// dropdown showed only the "(default)" sentinel with nothing else to pick
// (codex-cli's catalog used to be `["(default)"]`). Every CLI provider must
// offer at least one real, invocable model alongside "(default)".
describe("CLI provider catalogs", () => {
  const cliProviders = PROVIDERS.filter((p) => p.kind === "cli");

  it("covers all three CLI providers", () => {
    expect(cliProviders.map((p) => p.id).sort()).toEqual([
      "anthropic-cli",
      "codex-cli",
      "gemini-cli",
    ]);
  });

  it.each(cliProviders)(
    "$id offers a real model, not just \"(default)\"",
    (def) => {
      const realModels = (def.catalog ?? []).filter((m) => m !== "(default)");
      expect(realModels.length).toBeGreaterThan(0);
    },
  );

  // The catalogs are the FULL model list per CLI, not a hand-picked pair.
  // Spot-check the entries a curated list would have dropped.
  it.each([
    ["codex-cli", ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex-spark"]],
    ["anthropic-cli", ["fable", "opus", "sonnet", "haiku"]],
    ["gemini-cli", ["gemini-3-pro-preview", "gemini-2.5-flash", "flash-lite"]],
  ] as const)("%s catalog carries the full list", (id, expected) => {
    const catalog = PROVIDERS.find((p) => p.id === id)?.catalog ?? [];
    for (const model of expected) expect(catalog).toContain(model);
    expect(catalog[0]).toBe(CLI_DEFAULT);
  });

  it("offers effort levels exactly where the CLI takes one", () => {
    const efforts = Object.fromEntries(
      cliProviders.map((p) => [p.id, p.efforts]),
    );
    // claude --effort, and codex -c model_reasoning_effort=…
    expect(efforts["anthropic-cli"]).toEqual([
      CLI_DEFAULT,
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(efforts["codex-cli"]).toContain("ultra");
    // gemini-cli has no effort flag — no picker, nothing passed.
    expect(efforts["gemini-cli"]).toBeUndefined();
  });

  it("never offers effort for a non-CLI provider", () => {
    const nonCli = PROVIDERS.filter((p) => p.kind !== "cli");
    expect(nonCli.filter((p) => p.efforts !== undefined)).toEqual([]);
  });
});

// Who may be offered in the Settings > Model INGEST row. Ingest writes pages
// into the vault, so a provider that cannot write them must never appear —
// the whole point of the filter. `builtin-local` belongs here now: it writes
// the pages itself, extractively, with no model call
// (lib/extractiveIngest.ts, runIngestProvider's offline branch).
describe("providerCanIngest", () => {
  it.each([
    // CLIs — real file tools.
    ["anthropic-cli", true],
    ["gemini-cli", true],
    ["codex-cli", true],
    // Server-side file operations.
    ["myco-pro", true],
    // Offline extractive writer.
    ["builtin-local", true],
    // Text-in / text-out — `complete({task:"ingest"})` throws for these.
    ["anthropic-api", false],
    ["openai-api", false],
    ["google-api", false],
    ["openrouter", false],
    ["ollama", false],
    // Not a provider at all.
    ["nonesuch", false],
  ] as const)("%s -> %s", (id, expected) => {
    expect(providerCanIngest(id)).toBe(expected);
  });

  it("keeps ollama out even though it shares builtin-local's kind", () => {
    const kinds = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.kind]));
    expect(kinds["ollama"]).toBe("local");
    expect(kinds["builtin-local"]).toBe("local");
    expect(providerCanIngest("ollama")).toBe(false);
  });

  it("names the built-in ingest model apart from the query one", () => {
    // Same provider, two roles: the Settings rows must not show one id for
    // both, or "offline ingest" reads as "offline retrieval".
    expect(BUILTIN_INGEST_MODEL).toBe("extractive-ingest");
    expect(BUILTIN_INGEST_MODEL).not.toBe(BUILTIN_MODEL);
  });
});

// Settings > Model's "Use the recommended setting": the app's out-of-box pick
// per task (Rust settings.rs default_query_* / default_ingest_*).
describe("isRecommendedModel", () => {
  it("names the native local defaults: 4B answers and 2B compilation", () => {
    expect(RECOMMENDED_MODEL.query).toEqual({
      provider: "builtin-local",
      model: BUILTIN_CHAT_MODEL,
      effort: CLI_DEFAULT,
    });
    expect(RECOMMENDED_MODEL.ingest).toEqual({
      provider: "builtin-local",
      model: BUILTIN_FAST_CHAT_MODEL,
      effort: CLI_DEFAULT,
    });
  });

  it("is true only when provider, model and effort all match", () => {
    expect(isRecommendedModel("query", RECOMMENDED_MODEL.query)).toBe(true);
    expect(isRecommendedModel("ingest", RECOMMENDED_MODEL.ingest)).toBe(true);
    // The other task's pick is not this task's recommendation.
    expect(isRecommendedModel("query", RECOMMENDED_MODEL.ingest)).toBe(false);
    expect(
      isRecommendedModel("query", { ...RECOMMENDED_MODEL.query, effort: "high" }),
    ).toBe(false);
    expect(
      isRecommendedModel("query", {
        ...RECOMMENDED_MODEL.query,
        model: "claude-sonnet-4-6",
      }),
    ).toBe(false);
    expect(
      isRecommendedModel("ingest", {
        ...RECOMMENDED_MODEL.ingest,
        provider: "codex-cli",
      }),
    ).toBe(false);
  });
});
