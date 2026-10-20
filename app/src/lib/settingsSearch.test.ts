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
  it("finds the deletion policy and treats legacy settings as recoverable", () => {
    expect(ids(matchSettings(STRINGS.ko, "삭제 방식", withSettings({})), "distill")).toContain("distill_deletion");
    const row = (permanent_delete?: boolean) => settingsRows(STRINGS.ko, withSettings({ permanent_delete })).find((r) => r.id === "distill_deletion")!;
    expect(row().changed).toBe(false);
    expect(row(false).value).toBe(STRINGS.ko.set_delete_trash);
    expect(row(true).value).toBe(STRINGS.ko.set_delete_permanent);
    expect(row(true).changed).toBe(true);
  });
  it("keeps the optional Qwen install card reachable in every UI language", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const values = { ...VALUES, lang };
      const matched = matchSettings(STRINGS[lang], "Qwen", values);
      expect(ids(matched, "model")).toContain("model_local_generation");
      expect(ids(matched, "model")).toContain("model_local_generation_fast");
      const row = settingsRows(STRINGS[lang], values).find((r) => r.id === "model_local_generation");
      expect(row?.label).toBe("Qwen3.5 4B");
      expect(row?.desc).toContain("E5");
      expect(row?.changed).toBe(false);
      const fast = settingsRows(STRINGS[lang], values).find((r) => r.id === "model_local_generation_fast");
      expect(fast?.label).toBe("Qwen3.5 2B");
      expect(ids(matchSettings(STRINGS[lang], "2B", values), "model")).toContain("model_local_generation_fast");
    }
  });
  it("does not advertise a Home background setting after Home becomes static", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      expect(settingsRows(STRINGS[lang], VALUES).map((row) => row.id)).not.toContain("appearance_ov_theme");
      expect(matchSettings(STRINGS[lang], STRINGS[lang].s_ov_theme, VALUES).size).toBe(0);
    }
  });
  it("blank query lists every tab with all of its rows", () => {
    const m = matchSettings(STRINGS.en, "", VALUES);
    expect(m.size).toBe(10);
    expect(ids(m, "model")).toContain("model_query");
    expect(ids(m, "providers").length).toBeGreaterThan(5);
  });

  it("finds the opt-in AI cards switch under Study, off by default", () => {
    const m = matchSettings(STRINGS.ko, "AI로 카드", VALUES);
    expect([...m.keys()]).toEqual(["study"]);
    expect(ids(m, "study")).toEqual(["study_ai_cards"]);
    const row = (aiCards: boolean) =>
      settingsRows(STRINGS.en, { ...VALUES, aiCards }).find((r) => r.id === "study_ai_cards")!;
    expect(row(false).changed).toBe(false);
    expect(row(true).changed).toBe(true);
  });

  it("finds the roam switch under Appearance, on by default", () => {
    const m = matchSettings(STRINGS.ko, "돌아다니기", VALUES);
    expect([...m.keys()]).toEqual(["appearance"]);
    expect(ids(m, "appearance")).toEqual(["appearance_roam"]);
    const row = (mascotRoam: boolean) =>
      settingsRows(STRINGS.en, { ...VALUES, mascotRoam }).find((r) => r.id === "appearance_roam")!;
    expect(row(true).changed).toBe(false);
    expect(row(false).changed).toBe(true);
  });

  it("finds the 3D myco card under Appearance in every language", () => {
    for (const [lang, q] of [["en", "3D"], ["ko", "입체"], ["ja", "立体"]] as const) {
      const m = matchSettings(STRINGS[lang], q, VALUES);
      expect(ids(m, "appearance")).toEqual(["appearance_myco3d"]);
    }
  });

  it("finds the fine grading switch under Study, off by default", () => {
    const m = matchSettings(STRINGS.ko, "세밀하게", VALUES);
    expect(ids(m, "study")).toEqual(["study_fine_grades"]);
    const row = (fineGrades: boolean) =>
      settingsRows(STRINGS.en, { ...VALUES, fineGrades }).find((r) => r.id === "study_fine_grades")!;
    expect(row(false).changed).toBe(false);
    expect(row(true).changed).toBe(true);
  });

  it("finds the plugin trust switch under Plugins, off until the vault is trusted", () => {
    const m = matchSettings(STRINGS.ko, "신뢰", VALUES);
    expect(ids(m, "plugins")).toContain("plugins_trust");
    const row = (pluginsTrusted: boolean) =>
      settingsRows(STRINGS.en, { ...VALUES, pluginsTrusted }).find(
        (r) => r.id === "plugins_trust",
      )!;
    expect(row(false).changed).toBe(false);
    expect(row(true).changed).toBe(true);
    expect(ids(matchSettings(STRINGS.en, "plugins", VALUES), "plugins")).toEqual([
      "plugins_trust",
      "plugins_list",
    ]);
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

  it("finds the text size row under Appearance, following the system by default", () => {
    const m = matchSettings(STRINGS.ko, "글자", VALUES);
    expect(ids(m, "appearance")).toContain("appearance_text_size");
    const row = (textSize: SettingsValues["textSize"]) =>
      settingsRows(STRINGS.ko, { ...VALUES, textSize }).find((r) => r.id === "appearance_text_size")!;
    expect(row("system").value).toBe(STRINGS.ko.s_text_size_system);
    expect(row("system").changed).toBe(false);
    expect(row("large").value).toBe(STRINGS.ko.s_text_size_large);
    expect(row("large").changed).toBe(true);
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
