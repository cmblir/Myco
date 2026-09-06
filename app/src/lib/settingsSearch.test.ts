import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import {
  isRowVisible,
  matchSettings,
  normalizeQuery,
  settingsRows,
  type SettingsValues,
} from "./settingsSearch";

const VALUES: SettingsValues = {
  settings: null,
  // ko is the shipped default UI language, so this fixture is a vault where
  // nothing has been touched.
  lang: "ko",
  theme: "dark",
  mascotEnabled: true,
  overviewTheme: "galaxy",
  indexedPages: null,
  budgetUsd: null,
};
const withSettings = (over: Record<string, unknown>): SettingsValues => ({
  ...VALUES,
  settings: {
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
    spotlight_shortcut: "Alt+Space",
    vault_history_enabled: false,
    pii_quarantine_enabled: false,
    notch_enabled: false,
    search_archived_sessions: false,
    ...over,
  } as SettingsValues["settings"],
});

const ids = (m: Map<string, { id: string }[]>, tab: string): string[] =>
  (m.get(tab as never) ?? []).map((r) => r.id);

describe("matchSettings", () => {
  it("blank query lists every tab with all of its rows", () => {
    const m = matchSettings(STRINGS.en, "", VALUES);
    expect(m.size).toBe(8);
    expect(ids(m, "model")).toContain("model_query");
    expect(ids(m, "providers").length).toBeGreaterThan(5);
  });

  it("a provider-name query keeps the Connections tab reachable", () => {
    // The bug this registry exists for: SETTINGS_INDEX held one key for the
    // whole tab (s_providers), so "Ollama" removed it from the rail even
    // though a matching card was inside.
    const m = matchSettings(STRINGS.en, "ollama", VALUES);
    expect(m.has("providers")).toBe(true);
    expect(ids(m, "providers")).toEqual(["provider_ollama"]);
  });

  it("a tab-title hit keeps every row of that tab", () => {
    const all = matchSettings(STRINGS.en, "", VALUES).get("appearance")!.length;
    // Most Appearance rows (mascot, notch, tray…) do not carry the word
    // "appearance" — the tab title does, and that brings the whole tab along.
    const own = settingsRows(STRINGS.en, VALUES).filter(
      (r) => r.tab === "appearance" && `${r.label} ${r.desc}`.toLowerCase().includes("appearance"),
    );
    expect(own.length).toBeLessThan(all);
    expect(matchSettings(STRINGS.en, STRINGS.en.s_appearance, VALUES).get("appearance")).toHaveLength(all);
  });

  it("narrows to the one row whose own text matches", () => {
    const m = matchSettings(STRINGS.en, "spend", VALUES);
    expect([...m.keys()]).toEqual(["model"]);
    expect(ids(m, "model")).toEqual(["model_budget"]);
  });

  it("matches a row on its current VALUE, not only its label", () => {
    const m = matchSettings(STRINGS.en, "haiku", withSettings({}));
    expect(ids(m, "model")).toEqual(["model_ingest"]);
  });

  it("ignores case and surrounding whitespace, and normalizes decomposed Hangul", () => {
    expect(matchSettings(STRINGS.en, "  SPEND ", VALUES)).toEqual(
      matchSettings(STRINGS.en, "spend", VALUES),
    );
    expect(matchSettings(STRINGS.ko, "언어".normalize("NFD"), VALUES).has("lang")).toBe(true);
    expect(normalizeQuery(" NFC ")).toBe("nfc");
  });

  it("matches in the current UI language only", () => {
    expect(matchSettings(STRINGS.ko, "월 지출", VALUES).has("model")).toBe(true);
    expect(matchSettings(STRINGS.ko, "Monthly spend", VALUES).has("model")).toBe(false);
  });

  it("returns an empty map when nothing matches", () => {
    expect(matchSettings(STRINGS.en, "zz-no-such-setting", VALUES).size).toBe(0);
  });

  it("changed-only keeps the rows that differ from their shipped default", () => {
    const m = matchSettings(STRINGS.en, "", withSettings({ auto_reindex_enabled: true }), true);
    expect(ids(m, "model")).toEqual(["model_autoreindex"]);
    // Nothing touched anywhere else, so no other tab survives the filter.
    expect([...m.keys()]).toEqual(["model"]);
  });

  it("a row with no known default is never counted as changed", () => {
    const rows = settingsRows(STRINGS.en, withSettings({}));
    const embeddings = rows.find((r) => r.id === "model_embeddings")!;
    expect(embeddings.def).toBe("");
    expect(embeddings.changed).toBe(false);
  });
});

describe("settingsRows", () => {
  it("prints the current value of a row and flags the ones off default", () => {
    const rows = settingsRows(STRINGS.en, withSettings({ tray_resident: true }));
    const tray = rows.find((r) => r.id === "appearance_tray")!;
    expect(tray.value).toBe(STRINGS.en.s_val_on);
    expect(tray.changed).toBe(true);
    const notch = rows.find((r) => r.id === "appearance_notch")!;
    expect(notch.changed).toBe(false);
  });

  it("resolves every label and every row id is unique", () => {
    const rows = settingsRows(STRINGS.en, VALUES);
    for (const r of rows) expect(r.label, r.id).toBeTruthy();
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("every row label resolves in ko and ja too", () => {
    for (const lang of ["ko", "ja"] as const) {
      for (const r of settingsRows(STRINGS[lang], VALUES)) {
        expect(r.label, `${lang}.${r.id}`).toBeTruthy();
      }
    }
  });
});

describe("isRowVisible", () => {
  it("shows a matched row and hides an unmatched one", () => {
    const matched = new Set(["model_query"]);
    expect(isRowVisible("model_query", matched)).toBe(true);
    expect(isRowVisible("model_budget", matched)).toBe(false);
  });

  it("fails OPEN for a card the registry does not know", () => {
    expect(isRowVisible("some_new_card", new Set())).toBe(true);
  });
});
