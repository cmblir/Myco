import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "./settingsStore";
import { ipc } from "../lib/ipc";
import type { MycoSettings } from "../lib/ipc";

// A model picked in the Model tab's dropdown flows through
// useSettingsStore.update() -> ipc.setSettings(), which is what the Rust side
// persists and later reads back to build the CLI invocation. This guards that
// picking a real (non-"(default)") model for each CLI provider actually lands
// in settings, not just in local component state.
const BASE = {
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
  query_model: "sonnet",
  ingest_provider: "anthropic-cli",
  ingest_model: "haiku",
  query_effort: "(default)",
  ingest_effort: "(default)",
} as unknown as MycoSettings;

describe("settingsStore.update — model selection persistence", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ settings: BASE, loading: false, error: null });
  });

  it.each([
    ["gemini-cli", "gemini-2.5-pro"],
    ["codex-cli", "gpt-5.6-sol"],
  ])("picking %s / %s persists to settings", async (provider, model) => {
    const setSettings = vi
      .spyOn(ipc, "setSettings")
      .mockResolvedValue(null as never);

    await useSettingsStore
      .getState()
      .update({ query_provider: provider, query_model: model });

    expect(useSettingsStore.getState().settings?.query_provider).toBe(
      provider,
    );
    expect(useSettingsStore.getState().settings?.query_model).toBe(model);
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ query_provider: provider, query_model: model }),
    );
  });

  // Effort is picked in the same card and persisted the same way — the Rust
  // side reads it back to build `claude --effort` / codex's
  // `-c model_reasoning_effort=`.
  it.each([
    ["query_effort", "xhigh"],
    ["ingest_effort", "low"],
  ])("picking %s = %s persists to settings", async (key, level) => {
    const setSettings = vi
      .spyOn(ipc, "setSettings")
      .mockResolvedValue(null as never);

    await useSettingsStore.getState().update({ [key]: level });

    expect(
      useSettingsStore.getState().settings?.[key as keyof MycoSettings],
    ).toBe(level);
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ [key]: level }),
    );
  });
});
