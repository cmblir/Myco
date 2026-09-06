// Survey (graph) view preferences — ONE layout, four questions. Persisted per
// device so the last question survives a reload. Everything that used to live
// here (13 layouts, 7 skins, 10 vibe presets, saved looks, 25 sliders,
// multiverse) is gone: a question changes the ENCODING (see graphEncoding.ts),
// never the engine, so there is nothing left to tune.

import { QUESTIONS, SIZE_BYS, type Question, type SizeBy } from "./graphEncoding";

export interface GraphSettings {
  question: Question;
  sizeBy: SizeBy;
  /** Hide the first-run sample notes (src-tauri/src/sample_vault.rs) so the
   * picture is only what the owner actually wrote. */
  hideSample: boolean;
  /** Draw unresolved [[wikilinks]] (no file behind them) as dashed ghosts. */
  showUnresolved: boolean;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  question: "orphans",
  sizeBy: "backlinks",
  hideSample: false,
  showUnresolved: true,
};

// v27: questions replaced layouts. The v26 blob held slider positions for
// engines that no longer exist — view prefs, not data — so it is simply left
// behind, no migration.
export const GRAPH_SETTINGS_KEY = "myco.graph.settings.v27";

export function loadGraphSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(GRAPH_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_GRAPH_SETTINGS };
    const p = JSON.parse(raw) as Partial<Record<keyof GraphSettings, unknown>>;
    return {
      question: QUESTIONS.includes(p.question as Question)
        ? (p.question as Question)
        : DEFAULT_GRAPH_SETTINGS.question,
      sizeBy: SIZE_BYS.includes(p.sizeBy as SizeBy)
        ? (p.sizeBy as SizeBy)
        : DEFAULT_GRAPH_SETTINGS.sizeBy,
      hideSample:
        typeof p.hideSample === "boolean" ? p.hideSample : DEFAULT_GRAPH_SETTINGS.hideSample,
      showUnresolved:
        typeof p.showUnresolved === "boolean"
          ? p.showUnresolved
          : DEFAULT_GRAPH_SETTINGS.showUnresolved,
    };
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS };
  }
}

export function saveGraphSettings(s: GraphSettings): void {
  try {
    localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* quota or disabled — the defaults are fine */
  }
}

/** The part of the settings that changes WHICH nodes exist. Only a change here
 * may rebuild the scene; question, size and search restyle in place. */
export function corpusKey(s: GraphSettings): string {
  return `${s.hideSample ? 1 : 0}${s.showUnresolved ? 1 : 0}`;
}

/** Everything a scene rebuild actually depends on, as one string. The build
 * effect keys off THIS, so the vault poll handing back an equal-but-new
 * adjacency object rebuilds nothing — and the "씬 재빌드 N회 · x ms" chip
 * counts real rebuilds only. Typing in the search box cannot move it. */
export function surveyBuildKey(
  s: GraphSettings,
  vault: { root: string; rev: number | undefined; files: number; mtimes: number },
): string {
  return [corpusKey(s), vault.root, vault.rev ?? -1, vault.files, vault.mtimes].join("|");
}
