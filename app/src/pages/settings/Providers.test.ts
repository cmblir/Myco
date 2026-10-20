// Settings → AI connections as static markup (node, no DOM), as
// Plugins.test.ts does.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MycoSettings } from "../../lib/ipc";

const settings = vi.hoisted(() => ({
  providers: {
    anthropic_cli: true,
    gemini_cli: false,
    codex_cli: false,
    anthropic_api: true,
    openai_api: false,
    google_api: false,
    ollama: false,
    openrouter: false,
    myco_pro: false,
    builtin_local: true,
  },
}));
vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: (select: (s: unknown) => unknown) =>
    select({
      settings: settings as unknown as MycoSettings,
      setProviderConnected: () => Promise.resolve(),
      update: () => Promise.resolve(),
      load: () => Promise.resolve(),
      syncOllama: () => Promise.resolve(),
    }),
}));

import { SettingsProviders, providerSwitchOn } from "./Providers";
import { STRINGS } from "../../lib/i18n";

const render = (lang: "ko" | "en" = "ko"): string =>
  renderToStaticMarkup(createElement(SettingsProviders, { t: STRINGS[lang] }));
const switchFor = (html: string, name: string): string =>
  html.match(
    new RegExp(`<button[^>]*role="switch"[^>]*aria-label="${name}[^"]*"[^>]*>`),
  )?.[0] ?? "";

describe("Settings → AI connections", () => {
  it("gives each connectable provider one switch, not a status chip and a button", () => {
    const t = STRINGS.ko;
    const html = render();
    expect(switchFor(html, "Claude Code \\(CLI\\)")).toMatch(
      /aria-checked="true"/,
    );
    expect(switchFor(html, "Gemini CLI")).toMatch(/aria-checked="false"/);
    expect(switchFor(html, "Anthropic API")).toMatch(/aria-checked="true"/);
    // The old Connect / Disconnect buttons are gone.
    expect(html).not.toMatch(new RegExp(`>${t.s_provider_connect}</button>`));
    expect(html).not.toMatch(
      new RegExp(`>${t.s_provider_disconnect}</button>`),
    );
  });

  it("says nothing in English on the Korean screen", () => {
    const html = render();
    expect(html).toContain(STRINGS.ko.s_provider_keychain_note);
    expect(html).not.toContain("API keys are stored");
    expect(html).not.toContain("checking ollama");
    // The kind chip is a word, not the catalog's "cli" / "api" / "local".
    expect(html).not.toMatch(/>(cli|api|local)</);
  });
});

describe("providerSwitchOn", () => {
  it("is off for a provider whose CLI the live check found missing", () => {
    expect(providerSwitchOn(true, false)).toBe(false);
    expect(providerSwitchOn(true, undefined)).toBe(true);
    expect(providerSwitchOn(true, true)).toBe(true);
    expect(providerSwitchOn(false, true)).toBe(false);
  });
});
