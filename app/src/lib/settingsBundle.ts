// Settings & looks export/import — the portable subset of the app's
// configuration, bundled into one JSON file so moving to a new machine (or
// backing up before an experiment) does not mean re-clicking through every
// tab. See docs/specs for the full inventory of what travels and what does
// not; the short version: visual/behavioural preferences travel, secrets and
// machine-shaped state (keychain keys, the vault path, the MCP token, window
// geometry, per-device "have I already told you about this" flags) do not.
//
// Rust `settings.json` fields are passed in/out by the caller (they need a
// Tauri round-trip); everything else here reads/writes localStorage directly,
// the same way each field's own module already does.

import type { MycoSettings } from "./ipc";
import { OVERVIEW_THEMES } from "./overviewThemes";
import {
  loadGraphSettings,
  saveGraphSettings,
  loadSavedLooks,
  writeSavedLooks,
  type GraphSettings,
  type SavedLook,
} from "./graphSettings";
import { loadViews, saveViews, type SavedView } from "./queryViews";
import { loadDismissed, saveDismissed } from "./linkSuggestions";
import { loadIgnored, saveIgnored, useReflectStore } from "../stores/reflectStore";
import { getBudgetThreshold, setBudgetThreshold } from "./budget";
import { useUIStore } from "../stores/uiStore";
import type { UIState } from "../stores/uiStore";

export const SETTINGS_BUNDLE_VERSION = 1;

/** Settings.json fields excluded from the bundle: account/session identity
 * tied to a keychain secret that never exports (myco_pro_url/email would show
 * "logged in as X" on a machine with no working credential — misleading, not
 * useful). Everything else in Settings is already documented as non-secret
 * (see settings.rs's own header comment), so this is a block-list. */
const SETTINGS_EXCLUDED_KEYS = ["myco_pro_url", "myco_pro_email"] as const;

/** `providers.myco_pro` (the connected-provider flag) rides inside the nested
 * `providers` object, so SETTINGS_EXCLUDED_KEYS above — which only strips
 * top-level `settings` keys — never reaches it, and it travels whole. That
 * flag must not travel without myco_pro_url/myco_pro_email, or an import
 * leaves a machine with no working credential showing myco Pro as connected.
 * Since those identity fields must not travel either (see comment above),
 * the flag is stripped the same way instead of being made to travel with
 * them. */
function omitProvidersMycoPro(settings: Record<string, unknown>): Record<string, unknown> {
  const providers = settings.providers;
  if (typeof providers !== "object" || providers === null) return settings;
  return { ...settings, providers: omit(providers as Record<string, unknown>, ["myco_pro"]) };
}

/** Graph-settings fields excluded: the live filter/mode state (search box,
 * tag/folder filter, multiverse toggle) is per-session, not part of a "look" —
 * mirrors exactly what saveLook() already strips when saving a named look. */
const GRAPH_EXCLUDED_KEYS = ["search", "tagFilter", "folderFilter", "multiverse"] as const;

/** uiStore fields included: this store is mostly navigation/session state
 * (route, splitRoute, expandedFolders, cmdOpen…), so an allow-list is safer
 * here than a block-list. */
const UI_KEYS = [
  "lang",
  "theme",
  "density",
  "accent",
  "showCitations",
  "mascotEnabled",
  "overviewTheme",
  "sidebarCollapsed",
  "splitRatio",
] as const;

/** Fields whose type is `string` but whose VALUE space is closed. A bundle
 *  carrying `lang: "zz"` type-checks as a string, persists into the ui store,
 *  and then throws at every `STRINGS[lang].key` call site (Spotlight, the
 *  tray payload, distill's notifications) — on every launch, because it was
 *  persisted. Enum fields are validated by value. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  // Mirrors i18n.ts `Lang`, uiStore's `Theme`/`Density`, and
  // overviewThemes.ts `OverviewThemeKey` (imported, not restated, so a new
  // theme cannot go missing here).
  lang: ["en", "ko", "ja"],
  theme: ["light", "dark", "system"],
  density: ["compact", "comfortable", "spacious"],
  overviewTheme: OVERVIEW_THEMES,
};

const SECTION_LABELS: Record<string, string> = {
  settings: "app settings",
  ui: "appearance",
  graph: "graph look",
  savedLooks: "saved graph looks",
  queryViews: "saved views",
  dismissedLinkSuggestions: "dismissed link suggestions",
  reflectIgnored: "reflect ignored items",
  budgetThresholdUsd: "budget alert threshold",
};

export interface SettingsBundle {
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  settings: Record<string, unknown>;
  ui: Record<string, unknown>;
  graph: Record<string, unknown>;
  savedLooks: SavedLook[];
  queryViews: SavedView[];
  dismissedLinkSuggestions: string[];
  reflectIgnored: string[];
  budgetThresholdUsd: number;
}

function omit(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

/** Gather the whole portable bundle. `currentSettings` comes from `ipc.getSettings()`
 * — a Tauri round-trip, so it's the caller's job, not this (Tauri-free) module's. */
export function buildSettingsBundle(
  appVersion: string,
  currentSettings: MycoSettings,
): SettingsBundle {
  return {
    schemaVersion: SETTINGS_BUNDLE_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    settings: omitProvidersMycoPro(
      omit(currentSettings as unknown as Record<string, unknown>, SETTINGS_EXCLUDED_KEYS),
    ),
    ui: pick(useUIStore.getState() as unknown as Record<string, unknown>, UI_KEYS),
    graph: omit(loadGraphSettings() as unknown as Record<string, unknown>, GRAPH_EXCLUDED_KEYS),
    savedLooks: loadSavedLooks(),
    queryViews: loadViews(),
    dismissedLinkSuggestions: [...loadDismissed()],
    reflectIgnored: [...loadIgnored()],
    budgetThresholdUsd: getBudgetThreshold(),
  };
}

// ---- validation -------------------------------------------------------

/** Overlay `input`'s known-typed fields onto `template` (the current
 * effective values, used both as the expected-type reference and as the
 * fallback for any field the import omits). Extra keys in `input` are
 * ignored; a field whose type doesn't match `template`'s is an error naming
 * the dotted path, and leaves that one field at its template value. */
function applyTemplate(
  template: Record<string, unknown>,
  input: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...template };
  if (input === undefined) return result;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    errors.push(`"${path}": expected an object`);
    return result;
  }
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(template)) {
    if (!(key in src)) continue;
    const want = template[key];
    const got = src[key];
    if (want !== null && typeof want === "object" && !Array.isArray(want)) {
      result[key] = applyTemplate(want as Record<string, unknown>, got, `${path}.${key}`, errors);
      continue;
    }
    if (typeof got !== typeof want || (typeof got === "number" && !Number.isFinite(got))) {
      errors.push(`"${path}.${key}": expected ${typeof want}, got ${got === null ? "null" : typeof got}`);
      continue;
    }
    const allowed = ENUM_VALUES[key];
    if (allowed && !allowed.includes(got as string)) {
      errors.push(
        `"${path}.${key}": expected one of ${allowed.join(", ")}, got ${String(got)}`,
      );
      continue;
    }
    result[key] = got;
  }
  return result;
}

function stringArray(input: unknown, path: string, errors: string[]): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || !input.every((x) => typeof x === "string")) {
    errors.push(`"${path}": expected an array of strings`);
    return [];
  }
  return input;
}

function savedLooksArray(input: unknown, path: string, errors: string[]): SavedLook[] {
  if (input === undefined) return [];
  const ok =
    Array.isArray(input) &&
    input.every(
      (x) =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as SavedLook).name === "string" &&
        typeof (x as SavedLook).settings === "object" &&
        (x as SavedLook).settings !== null,
    );
  if (!ok) {
    errors.push(`"${path}": expected an array of saved looks ({name, settings})`);
    return [];
  }
  return input as SavedLook[];
}

function savedViewsArray(input: unknown, path: string, errors: string[]): SavedView[] {
  if (input === undefined) return [];
  const ok =
    Array.isArray(input) &&
    input.every((x) => typeof x === "object" && x !== null && typeof (x as SavedView).id === "string");
  if (!ok) {
    errors.push(`"${path}": expected an array of saved views ({id, ...})`);
    return [];
  }
  return input as SavedView[];
}

export interface ValidatedSettingsBundle {
  settings: Record<string, unknown>;
  ui: Record<string, unknown>;
  graph: Record<string, unknown>;
  savedLooks: SavedLook[];
  queryViews: SavedView[];
  dismissedLinkSuggestions: string[];
  reflectIgnored: string[];
  budgetThresholdUsd: number;
  /** Top-level section keys actually present in the imported file — used to
   *  report which sections were restored. */
  present: Set<string>;
}

export type ValidateResult =
  | { ok: true; data: ValidatedSettingsBundle }
  | { ok: false; error: string };

/** Validate a parsed export against the CURRENT effective state (used as
 * both the type template and the fallback for omitted fields). Collects
 * every error before returning — never stops at the first one, so a caller
 * that only applies on `ok: true` never partially applies a bad import. */
export function validateSettingsBundle(raw: unknown, currentSettings: MycoSettings): ValidateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "not a myco settings export (not a JSON object)" };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.schemaVersion !== "number") {
    return { ok: false, error: '"schemaVersion": expected a number' };
  }
  if (r.schemaVersion > SETTINGS_BUNDLE_VERSION) {
    return {
      ok: false,
      error: `this file was exported by a newer version of myco (settings format v${r.schemaVersion}); this app supports up to v${SETTINGS_BUNDLE_VERSION}`,
    };
  }

  const errors: string[] = [];
  const settingsTemplate = omit(currentSettings as unknown as Record<string, unknown>, SETTINGS_EXCLUDED_KEYS);
  const uiTemplate = pick(useUIStore.getState() as unknown as Record<string, unknown>, UI_KEYS);
  const graphTemplate = omit(loadGraphSettings() as unknown as Record<string, unknown>, GRAPH_EXCLUDED_KEYS);

  const settings = applyTemplate(settingsTemplate, r.settings, "settings", errors);
  // Never let an import set providers.myco_pro — this machine's own value
  // always wins, matching myco_pro_url/email above (which the flag is
  // meaningless without). Enforced here too, not just at export, so a
  // hand-edited or pre-fix export file can't smuggle it back in.
  if (settings.providers && typeof settings.providers === "object") {
    (settings.providers as Record<string, unknown>).myco_pro = (
      currentSettings.providers as unknown as Record<string, unknown>
    ).myco_pro;
  }
  const ui = applyTemplate(uiTemplate, r.ui, "ui", errors);
  const graph = applyTemplate(graphTemplate, r.graph, "graph", errors);
  const savedLooks = savedLooksArray(r.savedLooks, "savedLooks", errors);
  const queryViews = savedViewsArray(r.queryViews, "queryViews", errors);
  const dismissedLinkSuggestions = stringArray(r.dismissedLinkSuggestions, "dismissedLinkSuggestions", errors);
  const reflectIgnored = stringArray(r.reflectIgnored, "reflectIgnored", errors);

  let budgetThresholdUsd = getBudgetThreshold();
  if (r.budgetThresholdUsd !== undefined) {
    if (typeof r.budgetThresholdUsd !== "number" || !Number.isFinite(r.budgetThresholdUsd) || r.budgetThresholdUsd < 0) {
      errors.push('"budgetThresholdUsd": expected a non-negative number');
    } else {
      budgetThresholdUsd = r.budgetThresholdUsd;
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }

  return {
    ok: true,
    data: {
      settings,
      ui,
      graph,
      savedLooks,
      queryViews,
      dismissedLinkSuggestions,
      reflectIgnored,
      budgetThresholdUsd,
      present: new Set(Object.keys(r)),
    },
  };
}

/** Write a validated bundle to every backing store. `setSettings` is injected
 * (rather than importing `ipc` here) so this module stays Tauri-free and
 * testable without mocking `invoke`. Returns the human-readable list of
 * sections that were present in the import (and so actually restored). */
export async function applySettingsBundle(
  data: ValidatedSettingsBundle,
  currentSettings: MycoSettings,
  setSettings: (s: MycoSettings) => Promise<unknown>,
): Promise<string[]> {
  await setSettings({ ...currentSettings, ...data.settings } as unknown as MycoSettings);
  useUIStore.setState(data.ui as unknown as Partial<UIState>);
  saveGraphSettings({ ...loadGraphSettings(), ...data.graph } as unknown as GraphSettings);
  writeSavedLooks(data.savedLooks);
  saveViews(data.queryViews);
  saveDismissed(new Set(data.dismissedLinkSuggestions));
  saveIgnored(new Set(data.reflectIgnored));
  useReflectStore.setState({ ignored: new Set(data.reflectIgnored) });
  setBudgetThreshold(data.budgetThresholdUsd);

  return Object.keys(SECTION_LABELS)
    .filter((k) => data.present.has(k))
    .map((k) => SECTION_LABELS[k]);
}
