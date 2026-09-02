// Settings search — which tabs match a query, in the current UI language.
// Inactive tabs are unmounted, so cross-tab matching needs this index; the
// cards of the active tab filter by their own rendered text (PageSettings).

import type { Strings } from "./i18n";

export type SettingsTab =
  | "account"
  | "model"
  | "providers"
  | "mcp"
  | "distill"
  | "lang"
  | "appearance"
  | "about";

/** Tab title key FIRST, then each card title key. Drives the rail only; cards filter by their own text. */
export const SETTINGS_INDEX: Record<SettingsTab, (keyof Strings)[]> = {
  account: ["s_account", "s_local_user", "s_vault_known"],
  model: [
    "s_model",
    "s_model_query",
    "s_model_ingest",
    "s_autoimport_title",
    "s_autoingest_title",
    "s_autoreflect_title",
    "s_budget_title",
    "s_embeddings",
    "s_autoreindex_title",
  ],
  providers: ["s_providers"],
  mcp: ["s_mcp", "mcp_command_label"],
  distill: [
    "s_distill",
    "set_distill_enabled_title",
    "set_distill_profile_injection_title",
    "set_profile_title",
    "set_distill_status_title",
    "vh_setting_title",
    "set_pii_title",
    "set_audit_title",
    "set_archive_title",
  ],
  lang: ["s_lang", "s_lang_ui"],
  appearance: [
    "s_appearance",
    "s_appearance_light",
    "s_appearance_dark",
    "s_appearance_system",
    "s_mascot",
    "s_ov_theme",
    "s_tray_resident_title",
    "s_notch_title",
    "s_spot_title",
  ],
  about: ["s_about", "up_check", "s_backup_title", "cr_last_crash"],
};

/** NFC + locale lowercase + trim: "  SPEND " and decomposed Hangul both match. */
export function normalizeQuery(s: string): string {
  return s.normalize("NFC").toLocaleLowerCase().trim();
}

/** Per tab, resolved labels containing `query`; tabs with no match absent; blank query → every label; missing optional keys skipped. */
export function matchSettings(
  t: Strings,
  query: string,
): Map<SettingsTab, string[]> {
  const q = normalizeQuery(query);
  const out = new Map<SettingsTab, string[]>();
  for (const tab of Object.keys(SETTINGS_INDEX) as SettingsTab[]) {
    const labels = SETTINGS_INDEX[tab]
      .map((k) => t[k])
      .filter((l): l is string => !!l && normalizeQuery(l).includes(q));
    if (labels.length > 0) out.set(tab, labels);
  }
  return out;
}
