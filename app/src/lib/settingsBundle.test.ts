import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MycoSettings } from "./ipc";
import { applySettingsBundle, buildSettingsBundle, validateSettingsBundle } from "./settingsBundle";
import { useUIStore } from "../stores/uiStore";
import { loadGraphSettings, saveGraphSettings } from "./graphSettings";
import { loadDismissed } from "./linkSuggestions";
import { loadIgnored } from "../stores/reflectStore";
import { loadViews } from "./queryViews";
import { getBudgetThreshold } from "./budget";

// The unit-test env is node (no DOM) — stand in a minimal localStorage, same
// shape as budget.test.ts / graphSettings.test.ts.
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

function fakeSettings(overrides: Partial<MycoSettings> = {}): MycoSettings {
  return {
    providers: {
      anthropic_cli: true,
      gemini_cli: false,
      codex_cli: false,
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
    myco_pro_url: "",
    myco_pro_email: "",
    auto_import_enabled: true,
    auto_import_interval_min: 30,
    auto_ingest_enabled: false,
    auto_ingest_interval_min: 60,
    auto_reflect_enabled: false,
    auto_reflect_interval_min: 180,
    auto_reindex_enabled: false,
    tray_resident: false,
    spotlight_shortcut: "",
    ...overrides,
  };
}

describe("buildSettingsBundle / exclusion", () => {
  it("never puts the myco Pro account email or url in the export", () => {
    const settings = fakeSettings({
      myco_pro_email: "someone@example.com",
      myco_pro_url: "https://pro.myco.example/secret-tenant",
    });
    const bundle = buildSettingsBundle("0.4.0", settings);
    expect(bundle.settings).not.toHaveProperty("myco_pro_email");
    expect(bundle.settings).not.toHaveProperty("myco_pro_url");
    expect(JSON.stringify(bundle)).not.toContain("someone@example.com");
    expect(JSON.stringify(bundle)).not.toContain("secret-tenant");
  });

  it("never puts providers.myco_pro in the export either — it's meaningless without the identity fields above", () => {
    const settings = fakeSettings({ providers: { ...fakeSettings().providers, myco_pro: true } });
    const bundle = buildSettingsBundle("0.4.0", settings);
    expect(bundle.settings.providers).not.toHaveProperty("myco_pro");
  });

  it("does not let an import flip providers.myco_pro on for a machine with no account", () => {
    const source = fakeSettings({ providers: { ...fakeSettings().providers, myco_pro: true } });
    const bundle = buildSettingsBundle("0.4.0", source);
    const raw = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    // Simulate a hand-crafted or pre-fix export that still carries the flag.
    (raw.settings as Record<string, unknown> & { providers: Record<string, unknown> }).providers.myco_pro = true;

    const target = fakeSettings(); // myco_pro: false, no account on this machine
    const result = validateSettingsBundle(raw, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data.settings.providers as Record<string, unknown>).myco_pro).toBe(false);
  });

  it("does not carry the live graph filter/mode state (session, not a look)", () => {
    saveGraphSettings({
      ...loadGraphSettings(),
      search: "leftover query",
      tagFilter: "project-x",
      folderFilter: "/some/vault/path",
      multiverse: true,
    });
    const bundle = buildSettingsBundle("0.4.0", fakeSettings());
    expect(bundle.graph).not.toHaveProperty("search");
    expect(bundle.graph).not.toHaveProperty("tagFilter");
    expect(bundle.graph).not.toHaveProperty("folderFilter");
    expect(bundle.graph).not.toHaveProperty("multiverse");
  });
});

describe("settings bundle round trip", () => {
  it("export -> import onto a different machine's state reproduces the same effective state", async () => {
    // "Machine A": distinctive values across every portable section.
    saveGraphSettings({ ...loadGraphSettings(), nodeSize: 2.5, brightness: 1.3 });
    useUIStore.setState({ theme: "light", density: "spacious", accent: "#ff00aa" });
    const sourceSettings = fakeSettings({ tray_resident: true, auto_ingest_enabled: true });

    const bundle = buildSettingsBundle("0.4.0", sourceSettings);
    const roundTripped = JSON.parse(JSON.stringify(bundle)) as unknown;

    // "Machine B": different current state, including excluded fields that
    // must survive the import untouched.
    saveGraphSettings({ ...loadGraphSettings(), nodeSize: 1, brightness: 1, tagFilter: "keep-me" });
    useUIStore.setState({ theme: "dark", density: "compact", sidebarCollapsed: true, route: "graph" });
    const targetSettings = fakeSettings({
      myco_pro_url: "https://this-machines-own-pro-url",
      myco_pro_email: "this-machine@example.com",
    });

    const result = validateSettingsBundle(roundTripped, targetSettings);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    let applied: MycoSettings = targetSettings;
    const sections = await applySettingsBundle(result.data, targetSettings, (s) => {
      applied = s;
      return Promise.resolve(null);
    });

    expect(applied.tray_resident).toBe(true);
    expect(applied.auto_ingest_enabled).toBe(true);
    // Excluded fields are this machine's own, never overwritten.
    expect(applied.myco_pro_url).toBe("https://this-machines-own-pro-url");
    expect(applied.myco_pro_email).toBe("this-machine@example.com");

    expect(loadGraphSettings().nodeSize).toBe(2.5);
    expect(loadGraphSettings().brightness).toBe(1.3);
    // Session-only filter state on the target machine is untouched.
    expect(loadGraphSettings().tagFilter).toBe("keep-me");

    const ui = useUIStore.getState();
    expect(ui.theme).toBe("light");
    expect(ui.density).toBe("spacious");
    expect(ui.accent).toBe("#ff00aa");
    // Navigation state (not in the export) stays whatever it already was.
    expect(ui.route).toBe("graph");

    expect(sections.length).toBeGreaterThan(0);
  });
});

describe("rejection cases", () => {
  it("rejects a wrong-typed field, naming it", () => {
    const bundle = buildSettingsBundle("0.4.0", fakeSettings());
    const raw = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    (raw.settings as Record<string, unknown>).tray_resident = "yes";
    const result = validateSettingsBundle(raw, fakeSettings());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("settings.tray_resident");
  });

  it("refuses a newer schema version honestly", () => {
    const bundle = buildSettingsBundle("9.9.9", fakeSettings());
    const raw = { ...bundle, schemaVersion: 999 };
    const result = validateSettingsBundle(raw, fakeSettings());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/i);
  });

  it("rejects a junk file that isn't a settings export object", () => {
    const result = validateSettingsBundle("just a string", fakeSettings());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a myco settings export/i);
  });

  it("never partially applies: unrelated state is untouched after a rejected import", () => {
    saveGraphSettings({ ...loadGraphSettings(), nodeSize: 1.75 });
    const bad = { schemaVersion: 1, settings: { tray_resident: "yes" } };
    const result = validateSettingsBundle(bad, fakeSettings());
    expect(result.ok).toBe(false);
    // Nothing was ever handed to applySettingsBundle, so nothing changed.
    expect(loadGraphSettings().nodeSize).toBe(1.75);
    expect(loadDismissed().size).toBe(0);
    expect(loadIgnored().size).toBe(0);
    expect(loadViews().length).toBe(0);
    expect(getBudgetThreshold()).toBe(20);
  });

  // A bogus enum value type-checks as a string, persists into the ui store,
  // and then throws at every STRINGS[lang] call site — on every launch.
  it("rejects an out-of-range enum value instead of persisting it", () => {
    const target = fakeSettings({});
    const bad = {
      schemaVersion: 1,
      appVersion: "0.4.0",
      ui: { lang: "zz" },
    };
    const res = validateSettingsBundle(bad, target);
    expect(res.ok).toBe(false);
  });
});
