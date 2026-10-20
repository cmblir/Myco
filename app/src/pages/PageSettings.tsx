// Settings — the shell: grouped navigation, search and the row filter. Every
// panel lives in ./settings/*.tsx; this file owns only which one is shown
// and which rows the registry (lib/settingsSearch) says match the query.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { getBudgetThreshold } from "../lib/budget";
import { isComposingKey } from "../lib/ime";
import {
  matchSettings,
  settingsRows,
  type SettingsTab,
  type SettingsValues,
} from "../lib/settingsSearch";
import AppPage from "../components/AppPage";
import { Check, PHONE_QUERY, useMediaQuery } from "../components/ui";
import { SettingsFilterContext } from "../components/SettingsCard";
import type { SettingsFilter } from "../components/SettingsCard";
import { useReindexStore } from "../stores/reindexStore";
import { usePluginStore } from "../stores/pluginStore";
import { useVaultStore } from "../stores/vaultStore";
import { SETTINGS_NAVIGATION_COPY } from "../lib/settingsNavigationCopy";
import { SETTINGS_SAVE_COPY } from "../lib/settingsSaveCopy";
import "../styles/settings-navigation.css";
import "../styles/settings-save.css";

import { SettingsAccount } from "./settings/Account";
import { SettingsModel } from "./settings/Model";
import { SettingsStudy } from "./settings/Study";
import { SettingsProviders } from "./settings/Providers";
import { SettingsMcp } from "./settings/Mcp";
import { SettingsDistill } from "./settings/Distill";
import { SettingsPlugins } from "./settings/Plugins";
import { SettingsLang } from "./settings/Lang";
import {
  SettingsAppearance,
  TextSizeSetting,
  TrayResidentToggle,
  NotchToggle,
  SpotlightShortcutRow,
} from "./settings/Appearance";
import { SettingsAbout } from "./settings/About";

export default function PageSettings({ t }: { t: Strings }): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const copy = SETTINGS_NAVIGATION_COPY[lang];
  const setLang = useUIStore((s) => s.setLang);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  // The store owns the tab so a deep link can name one (see uiStore.settingsTab).
  const tab = useUIStore((s) => s.settingsTab);
  const setTab = useUIStore((s) => s.setSettingsTab);
  const [isAdvancedExpanded, setAdvancedExpanded] = useState(false);
  // A phone (UX S54): the list of sections, then one section with a way back,
  // instead of the cards with a panel running on beneath them.
  const phone = useMediaQuery(PHONE_QUERY);
  const [phoneDetail, setPhoneDetail] = useState(false);
  // Distinguishes our own tab switches (rail click, search) from a deep link
  // arriving from elsewhere; see the effect below.
  const ownTabChange = useRef(false);
  const selectTab = (next: SettingsTab): void => {
    if (next === tab) return;
    ownTabChange.current = true;
    setTab(next);
  };
  const [q, setQ] = useState("");
  // The last value typed outside an IME composition: matching on every
  // keystroke of a Hangul syllable would flip the tab mid-character.
  const [applied, setApplied] = useState("");
  const changedOnly = useUIStore((s) => s.settingsChangedOnly);
  const setChangedOnly = useUIStore((s) => s.setSettingsChangedOnly);

  // One registry drives all three: which tabs the rail shows, which cards the
  // body renders, and what each row is currently set to (lib/settingsSearch).
  const mascotEnabled = useUIStore((s) => s.mascotEnabled);
  const mascotRoam = useUIStore((s) => s.mascotRoam);
  const aiCards = useUIStore((s) => s.aiCards);
  const fineGrades = useUIStore((s) => s.fineGrades);
  const textSize = useUIStore((s) => s.textSize);
  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const saved = useSettingsStore((s) => s.saved);
  const saveError = useSettingsStore((s) => s.error);
  const loading = useSettingsStore((s) => s.loading);
  const loadSettings = useSettingsStore((s) => s.load);
  const saveCopy = SETTINGS_SAVE_COPY[lang];
  const indexedPages = useReindexStore((s) => s.indexedPages);
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const pluginsTrusted = usePluginStore(
    (s) => !!vaultPath && s.trusted.includes(vaultPath),
  );
  const values: SettingsValues = useMemo(
    () => ({
      settings,
      lang,
      theme,
      mascotEnabled,
      mascotRoam,
      aiCards,
      fineGrades,
      pluginsTrusted,
      textSize,
      indexedPages,
      budgetUsd: getBudgetThreshold(),
    }),
    [
      settings,
      lang,
      theme,
      mascotEnabled,
      mascotRoam,
      aiCards,
      fineGrades,
      pluginsTrusted,
      textSize,
      indexedPages,
    ],
  );
  const matches = useMemo(
    () => matchSettings(t, applied, values, changedOnly),
    [t, applied, values, changedOnly],
  );
  const filter = useMemo<SettingsFilter>(() => {
    const rows = matches.get(tab) ?? [];
    const byId = new Map(settingsRows(t, values).map((r) => [r.id, r]));
    return {
      matched: new Set(rows.map((r) => r.id)),
      row: (id) => byId.get(id),
    };
  }, [matches, tab, t, values]);

  function applyQuery(v: string, onlyChanged = changedOnly): void {
    setApplied(v);
    // Current tab dropped out → the first tab that still matches. Done here,
    // not in an effect, so the switch sticks after the query is cleared.
    const hit = matchSettings(t, v, values, onlyChanged);
    const first = hit.keys().next();
    if (!first.done && !hit.has(tab)) selectTab(first.value);
  }

  // A tab set from outside (chip's MCP row, Ask's profile CTA) must win over
  // the filters: a leftover query or changed-only filter can hide its cards.
  useEffect(() => {
    if (ownTabChange.current) {
      ownTabChange.current = false;
      return;
    }
    setQ("");
    setApplied("");
    setChangedOnly(false);
  }, [tab, setChangedOnly]);

  function backToList(): void {
    setPhoneDetail(false);
    // Back on the section's own row, as a list → detail → back should land.
    requestAnimationFrame(() => document.getElementById(`settings-choice-${tab}`)?.focus());
  }

  // Keep the familiar find shortcut without opening a mobile keyboard on arrival.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function clearSearch(): void {
    setQ("");
    applyQuery("");
  }

  const basicTabs: { id: SettingsTab; label: string; icon: IconName }[] = [
    { id: "account", label: t.s_account, icon: "shield" },
    { id: "model", label: t.s_model, icon: "sparkles" },
    { id: "study", label: t.nav_study, icon: "book" },
    { id: "appearance", label: t.s_appearance, icon: "moon" },
    { id: "lang", label: t.s_lang, icon: "globe" },
  ];
  const advancedTabs: typeof basicTabs = [
    { id: "providers", label: t.s_providers, icon: "link" },
    { id: "mcp", label: t.s_mcp, icon: "terminal" },
    { id: "distill", label: t.s_distill ?? "Distill", icon: "bolt" },
    { id: "plugins", label: t.s_plugins, icon: "spark" },
    { id: "about", label: t.s_about, icon: "info" },
  ];
  const isAdvancedActive = advancedTabs.some((item) => item.id === tab);
  const hasAdvancedMatches = advancedTabs.some((item) => matches.has(item.id));
  const isFiltering = applied.trim().length > 0 || changedOnly;

  // Search and links from other pages must reveal the selected section.
  useEffect(() => {
    if (isAdvancedActive || (isFiltering && hasAdvancedMatches)) {
      setAdvancedExpanded(true);
    }
  }, [tab, applied, isAdvancedActive, isFiltering, hasAdvancedMatches]);

  function renderChoices(choices: typeof basicTabs): JSX.Element[] {
    return choices
      .filter((item) => matches.has(item.id))
      .map((item) => (
        <button
          key={item.id}
          id={`settings-choice-${item.id}`}
          type="button"
          aria-current={tab === item.id ? "page" : undefined}
          aria-controls="settings-panel"
          className="settings-navigation__choice"
          onClick={() => {
            selectTab(item.id);
            setPhoneDetail(true);
          }}
        >
          <span aria-hidden="true">
            <Icon name={item.icon} size={16} />
          </span>
          <span>{item.label}</span>
        </button>
      ));
  }

  const basicChoices = renderChoices(basicTabs);
  const rows = settingsRows(t, values);
  const shown = [...matches.values()].reduce((n, list) => n + list.length, 0);
  const numberFormat = new Intl.NumberFormat(lang);

  return (
    <AppPage
      className={phone ? (phoneDetail ? "settings-page is-detail" : "settings-page is-list") : undefined}
      eyebrow={t.nav_settings}
      title={t.s_title}
      note={copy.intro}
      tools={
        isFiltering ? (
          <span className="s-total" role="status">
            {(t.s_total_count ?? "{n} of {all} settings")
              .replace("{n}", numberFormat.format(shown))
              .replace("{all}", numberFormat.format(rows.length))}
          </span>
        ) : null
      }
      bar={
        <div className="settings-navigation">
          <div className="settings-navigation__search">
            <div className="s-box">
              <span className="s-box__ico" aria-hidden="true">
                <Icon name="search" size={14} />
              </span>
              <input
                ref={searchRef}
                type="search"
                value={q}
                placeholder={t.s_search_ph}
                aria-label={t.s_search_ph}
                onChange={(e) => {
                  setQ(e.target.value);
                  // Mid-composition keystrokes only update the field; `applied`
                  // follows on compositionend.
                  if (!(e.nativeEvent as InputEvent).isComposing) {
                    applyQuery(e.target.value);
                  }
                }}
                onCompositionEnd={(e) => applyQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (isComposingKey(e)) return;
                  if (e.key === "Escape") clearSearch();
                }}
              />
              {q ? (
                <button
                  className="s-box__clear"
                  aria-label={t.s_search_clear ?? "Clear search"}
                  onClick={() => {
                    clearSearch();
                    searchRef.current?.focus();
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              ) : null}
            </div>
            <Check
              checked={changedOnly}
              onChange={(next) => {
                setChangedOnly(next);
                applyQuery(applied, next);
              }}
              label={t.s_changed_only ?? "Changed only"}
            />
          </div>
          <nav aria-label={t.s_title}>
            {basicChoices.length > 0 ? (
              <div
                className="settings-navigation__group"
                role="group"
                aria-label={copy.basic}
              >
                <p className="settings-navigation__label">{copy.basic}</p>
                <div className="settings-navigation__choices">
                  {basicChoices}
                </div>
              </div>
            ) : null}
            {hasAdvancedMatches ? (
              <details
                className="settings-navigation__advanced"
                open={isAdvancedExpanded}
                onToggle={(event) =>
                  setAdvancedExpanded(event.currentTarget.open)
                }
              >
                <summary>
                  <span
                    className="settings-navigation__disclosure"
                    aria-hidden="true"
                  >
                    <Icon name="chevR" size={16} />
                  </span>
                  <span>{copy.advanced}</span>
                  <span className="settings-navigation__hint">
                    {copy.advancedHint}
                  </span>
                </summary>
                <div className="settings-navigation__choices">
                  {renderChoices(advancedTabs)}
                </div>
              </details>
            ) : null}
          </nav>
        </div>
      }
    >
      <div
        className="s-body"
        id="settings-panel"
        role={matches.has(tab) ? "region" : undefined}
        aria-labelledby={
          matches.has(tab) ? `settings-choice-${tab}` : undefined
        }
      >
        {phone && phoneDetail ? (
          <button type="button" className="btn btn-ghost settings-back" onClick={backToList}>
            <Icon name="chevL" size={16} />
            {t.s_back_list}
          </button>
        ) : null}
        {saveError ? (
          <div className="settings-save settings-save--error" role="alert">
            <span>
              {settings ? saveCopy.failed : saveCopy.unavailable}
              <span className="settings-save__details">{saveError}</span>
              {!settings && (
                <button
                  type="button"
                  className="btn settings-save__retry"
                  disabled={loading}
                  onClick={() => void loadSettings()}
                >
                  {saveCopy.reload}
                </button>
              )}
            </span>
          </div>
        ) : saving || saved ? (
          <div className="settings-save" role="status" aria-live="polite">
            <Icon name={saving ? "save" : "check"} size={14} />
            <span>{saving ? saveCopy.saving : saveCopy.saved}</span>
          </div>
        ) : null}
        {matches.size === 0 ? (
          <div className="s-empty" role="status">
            <div>
              {(t.s_search_empty ?? "No settings match “{q}”").replace(
                "{q}",
                applied,
              )}
            </div>
            <button
              className="btn btn-primary"
              onClick={() => {
                clearSearch();
                setChangedOnly(false);
              }}
            >
              {t.s_show_all ?? "Show every setting"}
            </button>
          </div>
        ) : (
          <SettingsFilterContext.Provider value={filter}>
            {tab === "account" ? <SettingsAccount t={t} /> : null}
            {tab === "model" ? <SettingsModel t={t} /> : null}
            {tab === "study" ? <SettingsStudy t={t} /> : null}
            {tab === "providers" ? <SettingsProviders t={t} /> : null}
            {tab === "mcp" ? <SettingsMcp t={t} /> : null}
            {tab === "distill" ? <SettingsDistill t={t} /> : null}
            {tab === "plugins" ? <SettingsPlugins t={t} /> : null}
            {tab === "lang" ? (
              <SettingsLang t={t} lang={lang} setLang={setLang} />
            ) : null}
            {tab === "appearance" ? (
              <div className="col" style={{ gap: 24 }}>
                <SettingsAppearance t={t} theme={theme} setTheme={setTheme} />
                <TextSizeSetting t={t} />
                <TrayResidentToggle t={t} />
                <NotchToggle t={t} />
                <SpotlightShortcutRow t={t} />
              </div>
            ) : null}
            {tab === "about" ? <SettingsAbout t={t} /> : null}
          </SettingsFilterContext.Provider>
        )}
      </div>
    </AppPage>
  );
}
