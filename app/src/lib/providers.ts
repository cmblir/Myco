// Provider catalog + connection logic, shared by the Settings Model tab and the
// topbar model picker. The model strings live here as `catalog` arrays; the
// selected values are plain strings stored in MycoSettings.query_model /
// ingest_model.

import { useEffect, useMemo, useState } from "react";
import type { ProviderId } from "./icons";
import type { Strings } from "./i18n";
import type { MycoSettings } from "./ipc";
import { ipc } from "./ipc";
import { useSettingsStore } from "../stores/settingsStore";

// The bundled offline chat/generate model's catalog id (Gemma 3 1B). Used for
// The catalog label for the built-in provider. No chat GGUF ships anymore —
// builtin-local queries answer extractively from the embedding index (see
// BUILTIN_EMBED_MODEL), so the "model" here names the retrieval stack.
export const BUILTIN_MODEL = "extractive-retrieval";

// The bundled offline embedding model's id (e5-small-ko — multilingual-e5-small
// fine-tuned for Korean retrieval; won the 2026-08 bake-off over the 10x-larger
// bge-m3 on the app's own harness). Used as the embedding-model key ("builtin-local:<id>") so a
// bundled-model swap invalidates stale vector indexes (see semantic_search's
// stale-index guard on the Rust side).
export const BUILTIN_EMBED_MODEL = "e5-small-ko";

export interface ProviderDef {
  id: ProviderId;
  flag: keyof MycoSettings["providers"]; // connection gate — picker shows connected only
  name: string;
  kind: "cli" | "api" | "local";
  needsKey: boolean;
  desc: string;
  catalog?: string[]; // fallback model list when API list fails
  /** Reasoning-effort levels this provider's CLI actually accepts, or absent
   * when it has no effort knob (then no effort picker is shown and nothing is
   * ever passed). "(default)" means "pass no effort flag at all". */
  efforts?: string[];
}

/** The "let the tool decide" sentinel, shared by the model and effort pickers.
 * Mirrors Rust's `claude::CLI_DEFAULT`. */
export const CLI_DEFAULT = "(default)";

/** Whether a provider can run Ingest, which writes files into the vault.
 * The three CLIs have real file tools (chat.ts's isCli branch) and myco Pro
 * applies file operations server-side (runIngestProvider); every other
 * provider is text-in/text-out and `complete({task:"ingest"})` throws for it.
 * Used to keep the Ingest picker from offering a provider that can only fail. */
export function providerCanIngest(id: string): boolean {
  return PROVIDERS.find((p) => p.id === id)?.kind === "cli" || id === "myco-pro";
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic-cli",
    flag: "anthropic_cli",
    name: "Claude Code (CLI)",
    kind: "cli",
    needsKey: false,
    desc: "Use your Claude Pro / Max subscription via the local `claude` CLI. No API key needed.",
    // Passed to `claude --model`: the four aliases the CLI resolves to their
    // latest version (fable is its own default), plus the one still-accepted
    // legacy id that has no alias. Full ids like "claude-sonnet-5" are what the
    // aliases resolve to, so they are left out as duplicates — "Custom…" takes
    // any id verbatim.
    catalog: [
      CLI_DEFAULT,
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "claude-opus-4-5",
    ],
    // `claude --help`: "Effort level for the current session (low, medium,
    // high, xhigh, max)".
    efforts: [CLI_DEFAULT, "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gemini-cli",
    flag: "gemini_cli",
    name: "Gemini CLI",
    kind: "cli",
    needsKey: false,
    desc: "Use your Google subscription via the local `gemini` CLI. No API key needed.",
    // The model registry the installed gemini CLI ships (modelConfigs.
    // modelDefinitions) plus its aliases — every value `-m` recognises.
    // No `efforts`: gemini-cli has no reasoning flag or env var, only
    // thinkingLevel/thinkingBudget inside the user's own ~/.gemini/settings.json.
    catalog: [
      CLI_DEFAULT,
      "auto",
      "pro",
      "flash",
      "flash-lite",
      "auto-gemini-3",
      "auto-gemini-2.5",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
      "gemini-3.1-flash-lite",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemma-4-31b-it",
      "gemma-4-26b-a4b-it",
    ],
  },
  {
    id: "codex-cli",
    flag: "codex_cli",
    name: "Codex CLI",
    kind: "cli",
    needsKey: false,
    desc: "Use your OpenAI subscription via the local `codex` CLI. No API key needed.",
    // Slugs passed to `codex exec --model`. This is only the fallback: the
    // picker asks the backend for the live list, which reads the CLI's own
    // ~/.codex/models_cache.json. Order = the cache's own priority order.
    catalog: [
      CLI_DEFAULT,
      "gpt-5.6-sol",
      "gpt-5.6-sol-wm",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "codex-auto-review",
    ],
    // Union of the per-model `supported_reasoning_levels` in that cache —
    // the levels are model-dependent, so a level the chosen model doesn't
    // support is rejected by codex itself, not here.
    efforts: [CLI_DEFAULT, "low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "anthropic-api",
    flag: "anthropic_api",
    name: "Anthropic API",
    kind: "api",
    needsKey: true,
    desc: "Direct calls to api.anthropic.com. Key from console.anthropic.com.",
    catalog: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
  },
  {
    id: "openai-api",
    flag: "openai_api",
    name: "OpenAI API",
    kind: "api",
    needsKey: true,
    desc: "GPT-5 family via api.openai.com.",
    catalog: ["gpt-5.4-mini", "gpt-5.4-nano"],
  },
  {
    id: "google-api",
    flag: "google_api",
    name: "Google AI",
    kind: "api",
    needsKey: true,
    desc: "Gemini family via generativelanguage.googleapis.com.",
    catalog: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
  },
  {
    id: "builtin-local",
    flag: "builtin_local",
    name: "Built-in (offline)",
    kind: "local",
    needsKey: false,
    desc: "Korean-aware e5 embedder bundled inside the app. Works offline with zero setup; Ask answers extractively from your notes via semantic search. No local chat model ships — features that write prose (ingest, overviews, digests) fall back to your ingest provider.",
    catalog: [BUILTIN_MODEL],
  },
  {
    id: "ollama",
    flag: "ollama",
    name: "Ollama (local)",
    kind: "local",
    needsKey: false,
    desc: "Run open-source models locally. Auto-detects http://localhost:11434.",
    catalog: [],
  },
  {
    id: "openrouter",
    flag: "openrouter",
    name: "OpenRouter",
    kind: "api",
    needsKey: true,
    desc: "One key for many providers (useful for model comparison).",
    catalog: [],
  },
  {
    id: "myco-pro",
    flag: "myco_pro",
    name: "myco Pro",
    kind: "api",
    needsKey: true,
    desc: "Unlimited ingest on a managed model — no API key or CLI needed. Sign in with your myco Pro account.",
    catalog: ["gemini-2.5-flash", "claude-haiku-4-5"],
  },
];

// i18n key per provider for its blurb; the English `desc:` above is the fallback.
const PROVIDER_DESC_KEYS: Record<ProviderId, keyof Strings> = {
  "anthropic-cli": "s_provider_desc_anthropic_cli",
  "gemini-cli": "s_provider_desc_gemini_cli",
  "codex-cli": "s_provider_desc_codex_cli",
  "anthropic-api": "s_provider_desc_anthropic_api",
  "openai-api": "s_provider_desc_openai_api",
  "google-api": "s_provider_desc_google_api",
  "builtin-local": "s_provider_desc_builtin_local",
  ollama: "s_provider_desc_ollama",
  openrouter: "s_provider_desc_openrouter",
  "myco-pro": "s_provider_desc_myco_pro",
};

/** Localised provider blurb, falling back to the English `desc:` on the def. */
export function providerDesc(t: Strings, def: ProviderDef): string {
  return t[PROVIDER_DESC_KEYS[def.id]] ?? def.desc;
}

/** Connected providers only, so pickers never point at an unavailable one.
 * Ollama is included when its daemon is detected live, even before the user
 * explicitly connects it. */
export function useEnabledProviders(): ProviderDef[] {
  const settings = useSettingsStore((s) => s.settings);
  // Ollama is selectable whenever the daemon is live with models installed —
  // not only after a model was pulled from inside myco. This keeps the Model
  // tab consistent with the "connected" chip on the Providers tab.
  const [ollamaLive, setOllamaLive] = useState(false);
  useEffect(() => {
    let alive = true;
    ipc
      .ollamaStatus()
      .then((s) => {
        if (alive) setOllamaLive(s.daemon_running && s.models.length > 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return useMemo(() => {
    if (!settings) return [PROVIDERS[0]];
    return PROVIDERS.filter((p) => {
      if (p.id === "ollama")
        return ollamaLive || settings.providers.ollama === true;
      return settings.providers[p.flag] === true;
    });
  }, [settings, ollamaLive]);
}
