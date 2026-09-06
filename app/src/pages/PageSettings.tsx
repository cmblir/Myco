// Settings — the shell: search, the tab chips and the row filter. Every
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
import { SettingsFilterContext } from "../components/SettingsCard";
import type { SettingsFilter } from "../components/SettingsCard";
import { useReindexStore } from "../stores/reindexStore";

import { SettingsAccount } from "./settings/Account";
import { SettingsModel } from "./settings/Model";
import { SettingsProviders } from "./settings/Providers";
import { SettingsMcp } from "./settings/Mcp";
import { SettingsDistill } from "./settings/Distill";
import { SettingsLang } from "./settings/Lang";
import {
  SettingsAppearance,
  SettingsOverviewTheme,
  TrayResidentToggle,
  NotchToggle,
  SpotlightShortcutRow,
} from "./settings/Appearance";
import { SettingsAbout } from "./settings/About";

export default function PageSettings({ t }: { t: Strings }): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const setLang = useUIStore((s) => s.setLang);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  // The store owns the tab so a deep link can name one (see uiStore.settingsTab).
  const tab = useUIStore((s) => s.settingsTab);
  const setTab = useUIStore((s) => s.setSettingsTab);
  // Distinguishes our own tab switches (rail click, search) from a deep link
  // arriving from elsewhere; see the effect below.
  const ownTabChange = useRef(false);
  const selectTab = (next: SettingsTab): void => {
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
  const overviewTheme = useUIStore((s) => s.overviewTheme);
  const settings = useSettingsStore((s) => s.settings);
  const indexedPages = useReindexStore((s) => s.indexedPages);
  const values: SettingsValues = useMemo(
    () => ({
      settings,
      lang,
      theme,
      mascotEnabled,
      overviewTheme,
      indexedPages,
      budgetUsd: getBudgetThreshold(),
    }),
    [settings, lang, theme, mascotEnabled, overviewTheme, indexedPages],
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

  function applyQuery(v: string): void {
    setApplied(v);
    // Current tab dropped out → the first tab that still matches. Done here,
    // not in an effect, so the switch sticks after the query is cleared.
    const hit = matchSettings(t, v, values, changedOnly);
    const first = hit.keys().next();
    if (!first.done && !hit.has(tab)) selectTab(first.value);
  }

  // A tab set from outside (chip's MCP row, Ask's profile CTA) must win over
  // the search state: a leftover query hides every card that does not match
  // it, so the deep link would land on a tab with nothing on it.
  useEffect(() => {
    if (ownTabChange.current) {
      ownTabChange.current = false;
      return;
    }
    setQ("");
    setApplied("");
  }, [tab]);

  // The rail is one horizontally scrolling row of chips, and the default tab
  // ("model") is not the first — without this it can open scrolled past the
  // active chip. `nearest` so an already-visible chip does not move the page.
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => {
    railRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  // Search IS the primary control, so it takes focus on arrival and answers
  // ⌘F / Ctrl+F — the key every user already presses to find something on a
  // page, which the browser would otherwise spend on its own find bar.
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

  const tabs: { id: typeof tab; label: string; icon: IconName }[] = [
    { id: "account", label: t.s_account, icon: "shield" },
    { id: "model", label: t.s_model, icon: "sparkles" },
    { id: "providers", label: t.s_providers, icon: "link" },
    { id: "mcp", label: t.s_mcp, icon: "terminal" },
    { id: "distill", label: t.s_distill ?? "Distill", icon: "bolt" },
    { id: "lang", label: t.s_lang, icon: "globe" },
    { id: "appearance", label: t.s_appearance, icon: "moon" },
    { id: "about", label: t.s_about, icon: "info" },
  ];

  const rows = settingsRows(t, values);
  const changedCount = rows.filter((r) => r.changed).length;
  const shown = [...matches.values()].reduce((n, list) => n + list.length, 0);

  return (
    <div className="workspace">
      <header className="page-head s-head">
        <div>
          <div className="page-eyebrow">{t.nav_settings}</div>
          <h1 className="page-title">{t.s_title}</h1>
        </div>
        <span className="s-total">
          {(t.s_total_count ?? "{n} of {all} settings")
            .replace("{n}", String(shown))
            .replace("{all}", String(rows.length))}
        </span>
      </header>

      {/* Search first: with eight tabs, "which tab is it on?" is the normal
          state, and the answer is a query — not a rail. */}
      <div className="s-searchrow">
        <div className="s-box">
          <span className="s-box__ico" aria-hidden="true">
            <Icon name="search" size={14} />
          </span>
          <input
            ref={searchRef}
            type="search"
            value={q}
            // Deliberate: this box IS the page's primary control.
            autoFocus
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
        <button
          className={"s-toggler" + (changedOnly ? " is-on" : "")}
          aria-pressed={changedOnly}
          onClick={() => setChangedOnly(!changedOnly)}
        >
          <span className="s-sw" aria-hidden="true" />
          <span>{t.s_changed_only ?? "Changed only"}</span>
          <span className="s-tabcount">{changedCount}</span>
        </button>
      </div>

      <nav
        className="s-rail"
        role="tablist"
        aria-label={t.s_title}
        ref={railRef}
      >
        {tabs
          .filter((x) => matches.has(x.id))
          .map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={tab === x.id}
              className="s-chip"
              onClick={() => selectTab(x.id)}
            >
              <Icon name={x.icon} size={13} />
              <span>{x.label}</span>
              <span className="s-tabcount">
                {matches.get(x.id)?.length ?? 0}
              </span>
            </button>
          ))}
      </nav>

      <div className="s-body">
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
            {tab === "providers" ? <SettingsProviders t={t} /> : null}
            {tab === "mcp" ? <SettingsMcp t={t} /> : null}
            {tab === "distill" ? <SettingsDistill t={t} /> : null}
            {tab === "lang" ? (
              <SettingsLang t={t} lang={lang} setLang={setLang} />
            ) : null}
            {tab === "appearance" ? (
              <div className="col" style={{ gap: 24 }}>
                <SettingsAppearance t={t} theme={theme} setTheme={setTheme} />
                <SettingsOverviewTheme t={t} />
                <TrayResidentToggle t={t} />
                <NotchToggle t={t} />
                <SpotlightShortcutRow t={t} />
              </div>
            ) : null}
            {tab === "about" ? <SettingsAbout t={t} /> : null}
          </SettingsFilterContext.Provider>
        )}
      </div>
    </div>
  );
}
