// Provider catalog + connection logic, shared by the Settings Model tab and the
// topbar model picker. The model strings live here as `catalog` arrays; the
// selected values are plain strings stored in MemexSettings.query_model /
// ingest_model.

import { useEffect, useMemo, useState } from "react";
import type { ProviderId } from "./icons";
import type { Strings } from "./i18n";
import type { MemexSettings } from "./ipc";
import { ipc } from "./ipc";
import { useSettingsStore } from "../stores/settingsStore";

// The bundled offline model's catalog id. Also used as the embedding-model
// key ("builtin-local:<id>") so a bundled-model swap invalidates stale vector
// indexes (see semantic_search's stale-index guard on the Rust side).
export const BUILTIN_MODEL = "gemma-3-1b";

export interface ProviderDef {
  id: ProviderId;
  flag: keyof MemexSettings["providers"]; // connection gate — picker shows connected only
  name: string;
  kind: "cli" | "api" | "local";
  needsKey: boolean;
  desc: string;
  catalog?: string[]; // fallback model list when API list fails
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic-cli",
    flag: "anthropic_cli",
    name: "Claude Code (CLI)",
    kind: "cli",
    needsKey: false,
    desc: "Use your Claude Pro / Max subscription via the local `claude` CLI. No API key needed.",
    // Aliases passed to `claude --model`; the CLI resolves each to its latest
    // version. Haiku first so high-volume ingest defaults to the cheapest model.
    catalog: ["haiku", "sonnet", "opus"],
  },
  {
    id: "gemini-cli",
    flag: "gemini_cli",
    name: "Gemini CLI",
    kind: "cli",
    needsKey: false,
    desc: "Use your Google subscription via the local `gemini` CLI. No API key needed.",
    catalog: ["(default)", "gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "codex-cli",
    flag: "codex_cli",
    name: "Codex CLI",
    kind: "cli",
    needsKey: false,
    desc: "Use your OpenAI subscription via the local `codex` CLI. No API key needed.",
    catalog: ["(default)"],
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
    desc: "Gemma 3 1B bundled inside the app. Works offline with zero setup; good for classification and light queries, use a cloud provider for high-quality ingest. Model © Google, provided under the Gemma Terms of Use (text ships with the app).",
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
    id: "memex-pro",
    flag: "memex_pro",
    name: "Memex Pro",
    kind: "api",
    needsKey: true,
    desc: "Unlimited ingest on a managed model — no API key or CLI needed. Sign in with your Memex Pro account.",
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
  "memex-pro": "s_provider_desc_memex_pro",
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
  // not only after a model was pulled from inside Memex. This keeps the Model
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
