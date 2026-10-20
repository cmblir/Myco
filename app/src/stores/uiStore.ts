// UI store. Holds presentation state that should outlive a single render but
// not require backend round-trips. Persisted to localStorage so window reopens
// keep their configuration.

import { create } from "zustand";
import {
  DEFAULT_OVERVIEW_THEME,
  isOverviewTheme,
  type OverviewThemeKey,
} from "../lib/overviewThemes";
import { persist } from "zustand/middleware";
import { SPLIT_DEFAULT_RATIO } from "../lib/splitRatio";
import type { Lang } from "../lib/i18n";
import type { Question as GraphQuestion } from "../lib/graphEncoding";
import type { AskScope, TierWeights } from "../lib/ipc";
import { DEFAULT_TIER_WEIGHTS } from "../lib/extractive";
import type { SettingsTab } from "../lib/settingsSearch";
import { isTextSize, type TextSize } from "../lib/textSize";
import {
  pushRoute,
  replaceCurrent,
  sanitizeHistory,
  step,
  type NavHistory,
} from "../lib/navHistory";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 600;
export const SIDEBAR_DEFAULT = 264;

export type Theme = "light" | "dark" | "system";
export type Density = "compact" | "comfortable" | "spacious";
export type RouteId =
  | "overview"
  | "ingest"
  | "query"
  | "graph"
  | "history"
  | "provenance"
  | "tasks"
  | "study"
  | "feedback"
  | "settings"
  | `page:${string}`;

const FIXED_ROUTES: readonly RouteId[] = [
  "overview",
  "ingest",
  "query",
  "graph",
  "history",
  "provenance",
  "tasks",
  "study",
  "feedback",
  "settings",
];

/** A persisted route is trusted only while the app still has a page for it:
 * the Views / Tags / Schedules routes were removed, and a store that closed on
 * one of them would otherwise rehydrate onto a pane nothing renders. */
function isRoute(r: unknown): r is RouteId {
  return typeof r === "string" && (FIXED_ROUTES.includes(r as RouteId) || r.startsWith("page:"));
}

export type FeedbackTab = "proposals" | "quarantine";
// The Read view ("preview") is gone: notes open in the one Live editor, and
// the markdown source view is the ⋯ menu's escape hatch. An older store's
// "preview" (like the removed "split") falls back to "live" in `merge`.
export type EditorMode = "live" | "source";
const EDITOR_MODES: readonly EditorMode[] = ["live", "source"];
const ASK_SCOPES: readonly AskScope[] = ["wiki", "sessions", "all"];

/** A persisted weight is only trusted as a finite 0..1 number; anything else
 * (hand-edited storage, a tier added since) falls back to the default. */
function sanitizeTierWeights(p: unknown): TierWeights {
  const src = (p ?? {}) as Partial<Record<keyof TierWeights, unknown>>;
  const out = { ...DEFAULT_TIER_WEIGHTS };
  for (const tier of Object.keys(out) as (keyof TierWeights)[]) {
    const v = src[tier];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) out[tier] = v;
  }
  return out;
}

export interface UIState {
  // Routing
  route: RouteId;
  // Back/forward stack of primary routes; `route` always sits at `idx`.
  navHistory: NavHistory;
  // Which tab the Feedback page opens on. Not persisted-meaningful state, but
  // it lives here so the activity panel / tray "N awaiting review" row can
  // deep-link straight to the quarantine tab (setRoute alone can't).
  feedbackTab: FeedbackTab;
  // Which tab the Settings page shows. Same story as feedbackTab: the chip's
  // MCP row / Ask's profile CTA name something that lives on a specific tab,
  // and setRoute("settings") alone dropped the user on the default one — with
  // nothing it named in sight, and no effect at all when Settings was already
  // the route. Single source of truth: the rail writes it too, so a second
  // deep link after a manual tab switch still moves.
  settingsTab: SettingsTab;
  // Settings: show only rows whose value differs from the shipped default.
  // Per device, like the other view prefs.
  settingsChangedOnly: boolean;
  // Deck path the Study page should open directly, or studyStore's
  // TODAY_REVIEW for every deck's due cards (ritual card's 복습 시작 — Q4
  // item 11, UX S34). Same deep-link idiom as feedbackTab, but consumed ONCE:
  // PageStudy reads it on mount and clears it, so later Study visits start at
  // the deck list as usual.
  studyDeck: string | null;
  // Section a navigation just asked for, e.g. the activity chip's "N suggested
  // links" row. setRoute alone left the user at the TOP of Overview with that
  // section far below the fold — and did nothing at all when Overview was
  // already the route. The nonce makes a repeat click re-fire; transient, so
  // `merge` drops whatever localStorage held.
  focusTarget: { id: string; nonce: number } | null;
  // Split view: when set, a SECOND pane shows this route beside the primary one
  // (e.g. Overview + Graph side by side). null = single pane.
  splitRoute: RouteId | null;
  // Primary pane's share of the split container (0..1). Clamped at
  // interaction time by clampSplitRatio; sanitized on rehydrate in merge.
  splitRatio: number;
  // Layout
  sidebarCollapsed: boolean;
  // Sidebar Tools disclosure (Study … Provenance). Per device — not in the
  // settings bundle.
  toolsOpen: boolean;
  cmdOpen: boolean;
  // Theme & i18n
  lang: Lang;
  theme: Theme;
  density: Density;
  // Note and Ask body size (lib/textSize). Per device, like the theme.
  textSize: TextSize;
  accent: string;
  showCitations: boolean;
  // MYCO mascot master switch — WCAG-style full opt-out (also the 14% of
  // users who reject any character presence). Off = static logo fallback.
  mascotEnabled: boolean;
  // Settings → Appearance: myco leaves the notch and roams the screen while
  // long work runs (lib/roamTrigger). On by default: the owner asked for it.
  mascotRoam: boolean;
  // Settings → Study: let a connected chat model draft study cards too
  // (quote-checked). Off by default — cards quote the note with no model.
  aiCards: boolean;
  // Settings → Study "Grade in detail": review with Again/Hard/Good/Easy
  // instead of Forgot/Remembered (UX S34). Off by default.
  fineGrades: boolean;
  // Which ambient background the Overview page runs. Named after the graph's
  // layouts on purpose — same vocabulary, two expressions — but deliberately a
  // SEPARATE key: the two are not linked, so changing one must not move the other.
  overviewTheme: OverviewThemeKey;
  // Sidebar tree
  expandedFolders: Record<string, boolean>;
  // Mycelium graph skin: the grow-in animation plays automatically only the
  // FIRST time the user ever sees it — after that it mounts fully grown, same
  // as the other layouts' one-shot intros. The toolbar timelapse button
  // replays it on demand regardless of this flag (see MyceliumView).
  myceliumGrown: boolean;
  // Morning-Report band (Q4 item 2): when Overview was last opened, epoch ms.
  // null until the first visit ever stamps it.
  lastVisitAt: number | null;
  // Vaults where the user opened the collapsed harvest row back into the full
  // queue, keyed by vault path. Absent = collapsed, which is the default for a
  // vault mid-harvest (see harvestSurface) — the hero is only for a first run.
  // A finished run writes `false` here: the user just acted, so the queue must
  // not re-present itself at full size.
  harvestExpanded: Record<string, boolean>;
  // Reader properties panel (frontmatter form) folded shut. Default open.
  propsCollapsed: boolean;
  // Reader editor mode; per device, no longer reset per file.
  editorMode: EditorMode;
  // Note info is closed by default; explicit choices persist per device.
  outlineOpen: boolean;
  // Opening note info folded the sidebar to fit beside the note; closing it
  // unfolds it again. Any other sidebar move hands the choice back.
  sidebarFoldedByRail: boolean;
  // Ask: last search scope and tier priors (the 고급 sliders). Per device,
  // like the other Ask prefs; sent with every question.
  askScope: AskScope;
  // An explicit choice, including wiki, remains authoritative across callers.
  isAskScopeExplicit: boolean;
  askTierWeights: TierWeights;
  // Graph deep link (`graph?q=…&n=…` — see lib/graphLink): the question the
  // arriving surface wants answered, and the note it wants selected. Consumed
  // ONCE by PageGraph on mount/update, like studyDeck; transient, so a stale
  // target can't reopen days later.
  graphFocus: { q: GraphQuestion; path: string | null } | null;

  setRoute: (route: RouteId) => void;
  /** Route sync after a rename/move: swaps the current entry, no history entry. */
  replaceRoute: (route: RouteId) => void;
  goBack: () => void;
  goForward: () => void;
  setFeedbackTab: (tab: FeedbackTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setSettingsChangedOnly: (v: boolean) => void;
  setStudyDeck: (path: string | null) => void;
  /** Point the next paint at a section (see focusTarget). */
  focusSection: (id: string) => void;
  clearFocusTarget: () => void;
  setSplitRoute: (route: RouteId | null) => void;
  setSplitRatio: (ratio: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  /** Fold the sidebar for note info, to unfold when note info closes. */
  foldSidebarForRail: () => void;
  toggleTools: () => void;
  setCmdOpen: (v: boolean) => void;
  toggleCmd: () => void;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setTextSize: (size: TextSize) => void;
  setAccent: (accent: string) => void;
  setShowCitations: (v: boolean) => void;
  setMascotEnabled: (v: boolean) => void;
  setMascotRoam: (v: boolean) => void;
  setAiCards: (v: boolean) => void;
  setFineGrades: (v: boolean) => void;
  setOverviewTheme: (v: OverviewThemeKey) => void;
  /** `fallback` is the open state shown while nothing is stored for `id`. */
  toggleFolder: (id: string, fallback?: boolean) => void;
  /** Open every listed folder (the tree revealing the open note). */
  expandFolders: (ids: string[]) => void;
  setMyceliumGrown: (v: boolean) => void;
  stampVisit: () => void;
  setHarvestExpanded: (vault: string, v: boolean) => void;
  setPropsCollapsed: (v: boolean) => void;
  setEditorMode: (mode: EditorMode) => void;
  toggleOutline: () => void;
  setAskScope: (scope: AskScope) => void;
  setAskTierWeights: (weights: TierWeights) => void;
  setGraphFocus: (focus: { q: GraphQuestion; path: string | null } | null) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      route: "overview",
      navHistory: { entries: ["overview"], idx: 0 },
      feedbackTab: "proposals",
      // What most people come to change (UX S22), not the AI model card.
      settingsTab: "appearance",
      settingsChangedOnly: false,
      studyDeck: null,
      focusTarget: null,
      splitRoute: null,
      splitRatio: SPLIT_DEFAULT_RATIO,
      sidebarCollapsed: false,
      toolsOpen: false,
      cmdOpen: false,
      lang: "ko",
      theme: "dark",
      overviewTheme: DEFAULT_OVERVIEW_THEME,
      density: "comfortable",
      textSize: "system",
      accent: "#181715",
      showCitations: true,
      mascotEnabled: true,
      mascotRoam: true,
      aiCards: false,
      fineGrades: false,
      // Keyed by absolute folder path (synthetic groups by id); all collapsed
      // except the Favorites and Recently edited groups. The old slug-keyed
      // seed never matched real paths.
      // __workspace (the sidebar's Workspace group, UX S43) is left unset:
      // its default follows the window height until the user picks.
      expandedFolders: { __favorites: true, __recent: true },
      myceliumGrown: false,
      lastVisitAt: null,
      harvestExpanded: {},
      propsCollapsed: false,
      editorMode: "live",
      outlineOpen: false,
      sidebarFoldedByRail: false,
      askScope: "wiki",
      isAskScopeExplicit: false,
      askTierWeights: DEFAULT_TIER_WEIGHTS,
      graphFocus: null,

      setRoute: (route) => set((s) => routePatch(s, route, pushRoute(s.navHistory, route))),
      replaceRoute: (route) =>
        set((s) => routePatch(s, route, replaceCurrent(s.navHistory, route))),
      goBack: () => set((s) => stepPatch(s, -1)),
      goForward: () => set((s) => stepPatch(s, 1)),
      setFeedbackTab: (feedbackTab) => set({ feedbackTab }),
      setSettingsTab: (settingsTab) => set({ settingsTab }),
      setSettingsChangedOnly: (settingsChangedOnly) => set({ settingsChangedOnly }),
      setStudyDeck: (studyDeck) => set({ studyDeck }),
      focusSection: (id) =>
        set((s) => ({
          focusTarget: {
            id,
            nonce: (s.focusTarget?.id === id ? s.focusTarget.nonce : 0) + 1,
          },
        })),
      clearFocusTarget: () => set({ focusTarget: null }),
      setSplitRoute: (route) =>
        set((s) => ({ splitRoute: route === s.route ? null : route })),
      setSplitRatio: (ratio) => set({ splitRatio: ratio }),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v, sidebarFoldedByRail: false }),
      toggleSidebar: () =>
        set({ sidebarCollapsed: !get().sidebarCollapsed, sidebarFoldedByRail: false }),
      foldSidebarForRail: () => set({ sidebarCollapsed: true, sidebarFoldedByRail: true }),
      toggleTools: () => set({ toolsOpen: !get().toolsOpen }),
      setCmdOpen: (v) => set({ cmdOpen: v }),
      toggleCmd: () => set({ cmdOpen: !get().cmdOpen }),
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setTextSize: (textSize) => set({ textSize }),
      setAccent: (accent) => set({ accent }),
      setShowCitations: (v) => set({ showCitations: v }),
      setMascotEnabled: (v) => set({ mascotEnabled: v }),
      setMascotRoam: (v) => set({ mascotRoam: v }),
      setAiCards: (v) => set({ aiCards: v }),
      setFineGrades: (v) => set({ fineGrades: v }),
      setOverviewTheme: (v) => set({ overviewTheme: v }),
      toggleFolder: (id, fallback = false) =>
        set({
          expandedFolders: {
            ...get().expandedFolders,
            // Default must match DirectoryRow's read default (collapsed/false),
            // so the first click reliably expands a not-yet-seen folder.
            [id]: !(get().expandedFolders[id] ?? fallback),
          },
        }),
      expandFolders: (ids) =>
        set({
          expandedFolders: {
            ...get().expandedFolders,
            ...Object.fromEntries(ids.map((id) => [id, true])),
          },
        }),
      setMyceliumGrown: (v) => set({ myceliumGrown: v }),
      stampVisit: () => set({ lastVisitAt: Date.now() }),
      setHarvestExpanded: (vault, v) =>
        set({ harvestExpanded: { ...get().harvestExpanded, [vault]: v } }),
      setPropsCollapsed: (v) => set({ propsCollapsed: v }),
      setEditorMode: (editorMode) => set({ editorMode }),
      toggleOutline: () =>
        set(
          get().outlineOpen && get().sidebarFoldedByRail
            ? { outlineOpen: false, sidebarCollapsed: false, sidebarFoldedByRail: false }
            : { outlineOpen: !get().outlineOpen },
        ),
      setAskScope: (askScope) => set({ askScope, isAskScopeExplicit: true }),
      setAskTierWeights: (askTierWeights) => set({ askTierWeights }),
      setGraphFocus: (graphFocus) => set({ graphFocus }),
    }),
    {
      name: "myco-ui",
      version: 3,
      // A store persisted before this key existed — or one holding a theme that
      // has since been removed — would otherwise hand the Overview page an
      // engine key with no factory behind it.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UIState>;
        const route = isRoute(p.route) ? p.route : "overview";
        return {
          ...current,
          ...p,
          route,
          splitRoute: isRoute(p.splitRoute) ? p.splitRoute : null,
          overviewTheme: isOverviewTheme(p.overviewTheme)
            ? p.overviewTheme
            : DEFAULT_OVERVIEW_THEME,
          // A hand-edited or corrupt persisted ratio would wedge a pane
          // off-screen with no handle left to grab.
          splitRatio:
            typeof p.splitRatio === "number" &&
            p.splitRatio > 0 &&
            p.splitRatio < 1
              ? p.splitRatio
              : SPLIT_DEFAULT_RATIO,
          editorMode: EDITOR_MODES.includes(p.editorMode as EditorMode)
            ? (p.editorMode as EditorMode)
            : "live",
          askScope: ASK_SCOPES.includes(p.askScope as AskScope)
            ? (p.askScope as AskScope)
            : "wiki",
          // Older stores cannot distinguish the default wiki value from a
          // manual selection; use automatic routing until the next choice.
          isAskScopeExplicit: p.isAskScopeExplicit === true,
          askTierWeights: sanitizeTierWeights(p.askTierWeights),
          textSize: isTextSize(p.textSize) ? p.textSize : "system",
          navHistory: sanitizeHistory(p.navHistory, route),
          // Transient by design: a persisted target would scroll+flash a
          // section on the next launch for a click made days ago. The graph
          // deep link is transient for the same reason, and so is the Settings
          // tab: Settings opens on Theme every launch (a deep link still picks
          // a tab within the session).
          focusTarget: null,
          graphFocus: null,
          settingsTab: "appearance",
          settingsChangedOnly: false,
          // The groups default open even for a store persisted before they
          // did; one the user closed stays closed.
          expandedFolders: {
            __favorites: true,
            __recent: true,
            ...p.expandedFolders,
          },
        };
      },
    },
  ),
);

/** For a satellite window that only reads this store (the notch): re-read it
 *  whenever another window saves it. The notch webview is retained, never
 *  reloaded, so without this a Settings change (the mascot, the language)
 *  reached it only on the next launch. `storage` fires in every OTHER
 *  same-origin document, never in the one that wrote. */
export function followUIStore(target: EventTarget = window): () => void {
  const onStorage = (e: Event): void => {
    if ((e as StorageEvent).key === "myco-ui") void useUIStore.persist.rehydrate();
  };
  target.addEventListener("storage", onStorage);
  return () => target.removeEventListener("storage", onStorage);
}

// Never let the primary and split panes show the SAME route (two live graph
// scenes, duplicate state) — clear the split if it would collide.
function routePatch(s: UIState, route: RouteId, navHistory: NavHistory): Partial<UIState> {
  return { route, navHistory, splitRoute: s.splitRoute === route ? null : s.splitRoute };
}

function stepPatch(s: UIState, delta: -1 | 1): Partial<UIState> {
  const h = step(s.navHistory, delta);
  return h ? routePatch(s, h.entries[h.idx], h) : s;
}
