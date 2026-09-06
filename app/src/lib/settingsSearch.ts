// Settings search — ONE registry of rows behind the tab rail, the body filter
// and the changed-only view.
//
// It used to be two criteria that disagreed. `SETTINGS_INDEX` (a list of title
// keys) decided which tabs the rail showed, while the cards of the active tab
// filtered themselves on their own rendered `textContent` through a
// MutationObserver. The Connections tab was indexed by a single key
// (`s_providers`), so searching "Ollama" removed the whole tab from the rail —
// with a matching card inside it, now unreachable. One registry fixes that by
// construction: a row IS the unit that matches, counts and renders.
//
// Values live here too, so a row can print what it is set to without opening
// the panel that owns it, and `changed` (≠ default) needs no second source of
// truth. A row whose value has no cheap source leaves both blank: the row
// shows no value and is never counted as changed — better than a guess.

import { DEFAULT_MONTHLY_THRESHOLD_USD } from "./budget";
import type { Lang, Strings } from "./i18n";
import type { MycoSettings } from "./ipc";
import { DEFAULT_OVERVIEW_THEME } from "./overviewThemes";
import { PROVIDERS, providerDesc } from "./providers";

export type SettingsTab =
  | "account"
  | "model"
  | "providers"
  | "mcp"
  | "distill"
  | "lang"
  | "appearance"
  | "about";

/** Tab title key per tab — a hit here shows every row of that tab. */
const TAB_TITLE: Record<SettingsTab, keyof Strings> = {
  account: "s_account",
  model: "s_model",
  providers: "s_providers",
  mcp: "s_mcp",
  distill: "s_distill",
  lang: "s_lang",
  appearance: "s_appearance",
  about: "s_about",
};

export const SETTINGS_TABS = Object.keys(TAB_TITLE) as SettingsTab[];

export function tabTitle(t: Strings, tab: SettingsTab): string {
  return t[TAB_TITLE[tab]];
}

/** Live state a row reads to print its current value. Everything here is
 *  already loaded by the Settings shell — no row triggers a fetch of its own. */
export interface SettingsValues {
  settings: MycoSettings | null;
  lang: Lang;
  theme: "light" | "dark" | "system";
  mascotEnabled: boolean;
  overviewTheme: string;
  /** Pages in the embedding index; null until `embeddings_status` answers. */
  indexedPages: number | null;
  /** Monthly spend cap in USD (localStorage-backed). */
  budgetUsd: number | null;
}

/** A resolved settings row: labels in the current language, current value,
 *  and whether that value differs from the shipped default. */
export interface SettingsRow {
  id: string;
  tab: SettingsTab;
  label: string;
  desc: string;
  /** Rendered current value; "" when the row has no cheap source. */
  value: string;
  /** The shipped default rendered the same way; "" when unknown (then the row
   *  is never "changed" — a row cannot be diffed against a value we lack). */
  def: string;
  changed: boolean;
}

interface RowDef {
  id: string;
  tab: SettingsTab;
  labelKey?: keyof Strings;
  /** Literal label for rows named by a catalog rather than by i18n (providers). */
  label?: string;
  descKey?: keyof Strings;
  /** Description for rows described by a catalog rather than by i18n. */
  desc?: (t: Strings) => string;
  value?: (v: SettingsValues, t: Strings) => string;
  def?: (t: Strings) => string;
}

const on = (t: Strings): string => t.s_val_on ?? "On";
const off = (t: Strings): string => t.s_val_off ?? "Off";
const flag = (b: boolean | undefined, t: Strings): string =>
  b === undefined ? "" : b ? on(t) : off(t);

const ROWS: RowDef[] = [
  { id: "account_user", tab: "account", labelKey: "s_local_user" },
  { id: "account_vaults", tab: "account", labelKey: "s_vault_known" },

  {
    id: "model_query",
    tab: "model",
    labelKey: "s_model_query",
    value: (v) => (v.settings ? `${v.settings.query_provider} · ${v.settings.query_model}` : ""),
    def: () => "anthropic-cli · sonnet",
  },
  {
    id: "model_ingest",
    tab: "model",
    labelKey: "s_model_ingest",
    value: (v) => (v.settings ? `${v.settings.ingest_provider} · ${v.settings.ingest_model}` : ""),
    def: () => "anthropic-cli · haiku",
  },
  {
    id: "model_embeddings",
    tab: "model",
    labelKey: "s_embeddings",
    descKey: "s_embeddings_lede",
    value: (v, t) =>
      v.indexedPages === null
        ? ""
        : v.indexedPages === 0
          ? (t.s_embeddings_empty ?? "Not indexed yet")
          : `${v.indexedPages} ${t.s_embeddings_indexed ?? "pages indexed"}`,
  },
  {
    id: "model_autoreindex",
    tab: "model",
    labelKey: "s_autoreindex_title",
    descKey: "s_autoreindex_desc",
    value: (v, t) => flag(v.settings?.auto_reindex_enabled, t),
    def: off,
  },
  {
    id: "model_archived",
    tab: "model",
    labelKey: "s_archived_sessions_title",
    descKey: "s_archived_sessions_desc",
    value: (v, t) => flag(v.settings?.search_archived_sessions, t),
    def: off,
  },
  {
    id: "model_autoimport",
    tab: "model",
    labelKey: "s_autoimport_title",
    descKey: "s_autoimport_desc",
    value: (v, t) => flag(v.settings?.auto_import_enabled, t),
    def: on,
  },
  {
    id: "model_autoingest",
    tab: "model",
    labelKey: "s_autoingest_title",
    descKey: "s_autoingest_desc",
    value: (v, t) => flag(v.settings?.auto_ingest_enabled, t),
    def: off,
  },
  {
    id: "model_autoreflect",
    tab: "model",
    labelKey: "s_autoreflect_title",
    descKey: "s_autoreflect_desc",
    value: (v, t) => flag(v.settings?.auto_reflect_enabled, t),
    def: off,
  },
  {
    id: "model_budget",
    tab: "model",
    labelKey: "s_budget_title",
    descKey: "s_budget_desc",
    value: (v) => (v.budgetUsd === null ? "" : `$${v.budgetUsd}`),
    def: () => `$${DEFAULT_MONTHLY_THRESHOLD_USD}`,
  },

  { id: "mcp_server", tab: "mcp", labelKey: "s_mcp", descKey: "mcp_lede" },
  { id: "mcp_register", tab: "mcp", labelKey: "mcp_command_label" },

  {
    id: "distill_enabled",
    tab: "distill",
    labelKey: "set_distill_enabled_title",
    descKey: "set_distill_enabled_desc",
  },
  {
    id: "distill_profile_injection",
    tab: "distill",
    labelKey: "set_distill_profile_injection_title",
    descKey: "set_distill_profile_injection_desc",
  },
  { id: "distill_profile", tab: "distill", labelKey: "set_profile_title", descKey: "set_profile_lede" },
  { id: "distill_status", tab: "distill", labelKey: "set_distill_status_title" },
  {
    id: "distill_history",
    tab: "distill",
    labelKey: "vh_setting_title",
    descKey: "vh_setting_desc",
    value: (v, t) => flag(v.settings?.vault_history_enabled, t),
    def: off,
  },
  {
    id: "distill_pii",
    tab: "distill",
    labelKey: "set_pii_title",
    descKey: "set_pii_desc",
    value: (v, t) => flag(v.settings?.pii_quarantine_enabled, t),
    def: off,
  },
  { id: "distill_audit", tab: "distill", labelKey: "set_audit_title" },
  { id: "distill_archive", tab: "distill", labelKey: "set_archive_title" },

  {
    id: "lang_ui",
    tab: "lang",
    labelKey: "s_lang_ui",
    descKey: "s_lang_lede",
    value: (v) => LANG_NAME[v.lang],
    def: () => LANG_NAME.ko,
  },

  {
    id: "appearance_theme",
    tab: "appearance",
    labelKey: "s_appearance",
    value: (v, t) =>
      v.theme === "light"
        ? t.s_appearance_light
        : v.theme === "dark"
          ? t.s_appearance_dark
          : t.s_appearance_system,
    def: (t) => t.s_appearance_dark,
  },
  {
    id: "appearance_ov_theme",
    tab: "appearance",
    labelKey: "s_ov_theme",
    value: (v) => v.overviewTheme,
    def: () => DEFAULT_OVERVIEW_THEME,
  },
  {
    id: "appearance_mascot",
    tab: "appearance",
    labelKey: "s_mascot",
    value: (v, t) => flag(v.mascotEnabled, t),
    def: on,
  },
  {
    id: "appearance_tray",
    tab: "appearance",
    labelKey: "s_tray_resident_title",
    descKey: "s_tray_resident_desc",
    value: (v, t) => flag(v.settings?.tray_resident, t),
    def: off,
  },
  {
    id: "appearance_notch",
    tab: "appearance",
    labelKey: "s_notch_title",
    descKey: "s_notch_desc",
    value: (v, t) => flag(v.settings?.notch_enabled, t),
    def: off,
  },
  {
    id: "appearance_spot",
    tab: "appearance",
    labelKey: "s_spot_title",
    descKey: "s_spot_desc",
    value: (v) => v.settings?.spotlight_shortcut ?? "",
    def: () => "Alt+Space",
  },

  { id: "about_update", tab: "about", labelKey: "up_check" },
  { id: "about_backup", tab: "about", labelKey: "s_backup_title" },
  { id: "about_crash", tab: "about", labelKey: "cr_last_crash" },
];

const LANG_NAME: Record<Lang, string> = { en: "English", ko: "한국어", ja: "日本語" };

// The Connections tab is generated from the provider catalog, not hand-listed:
// that is exactly the tab the old single-key index could not represent.
const PROVIDER_ROWS: RowDef[] = PROVIDERS.map((p) => ({
  id: `provider_${p.id}`,
  tab: "providers" as const,
  label: p.name,
  desc: (t: Strings) => providerDesc(t, p),
  value: (v: SettingsValues, t: Strings) => flag(v.settings?.providers[p.flag], t),
  // ProviderFlags::default() in settings.rs: the Claude CLI and the bundled
  // local model ship connected, everything else off.
  def: p.flag === "anthropic_cli" || p.flag === "builtin_local" ? on : off,
}));

/** Every row id the registry knows. A card whose id is absent fails OPEN (the
 *  filter never hides a control the registry forgot). */
export const ROW_IDS: ReadonlySet<string> = new Set(
  [...ROWS, ...PROVIDER_ROWS].map((r) => r.id),
);

/** The registry resolved against the current language and vault state. */
export function settingsRows(t: Strings, v: SettingsValues): SettingsRow[] {
  return [...ROWS, ...PROVIDER_ROWS].map((r) => {
    const value = r.value?.(v, t) ?? "";
    const def = r.def?.(t) ?? "";
    return {
      id: r.id,
      tab: r.tab,
      label: r.label ?? (r.labelKey ? t[r.labelKey] : r.id),
      desc: r.desc?.(t) ?? (r.descKey ? t[r.descKey] : ""),
      value,
      def,
      changed: def !== "" && value !== "" && value !== def,
    };
  });
}

/** NFC + locale lowercase + trim: "  SPEND " and decomposed Hangul both match. */
export function normalizeQuery(s: string): string {
  return s.normalize("NFC").toLocaleLowerCase().trim();
}

/** Rows per tab for `query`, in tab order; a tab with no surviving row is
 *  absent. A hit on the TAB TITLE keeps every row of that tab; otherwise a row
 *  matches on its own text (label + description + current value).
 *  `changedOnly` additionally drops rows still at their default. */
export function matchSettings(
  t: Strings,
  query: string,
  v: SettingsValues,
  changedOnly = false,
): Map<SettingsTab, SettingsRow[]> {
  const q = normalizeQuery(query);
  const rows = settingsRows(t, v);
  const tabHit = new Map<SettingsTab, boolean>(
    SETTINGS_TABS.map((tab) => [tab, !!q && normalizeQuery(tabTitle(t, tab)).includes(q)]),
  );
  const out = new Map<SettingsTab, SettingsRow[]>();
  for (const tab of SETTINGS_TABS) {
    const hits = rows.filter(
      (r) =>
        r.tab === tab &&
        (!q ||
          tabHit.get(tab) ||
          normalizeQuery(`${r.label} ${r.desc} ${r.value}`).includes(q)) &&
        (!changedOnly || r.changed),
    );
    if (hits.length > 0) out.set(tab, hits);
  }
  return out;
}

/** Should the card for `id` render? Rows the registry does not know always do. */
export function isRowVisible(id: string, matched: ReadonlySet<string>): boolean {
  return matched.has(id) || !ROW_IDS.has(id);
}
