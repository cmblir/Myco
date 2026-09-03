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
  | "tags"
  | "views"
  | "study"
  | "feedback"
  | "schedules"
  | "settings"
  | `page:${string}`;

export type FeedbackTab = "proposals" | "quarantine";
export type EditorMode = "live" | "source" | "split" | "preview";
const EDITOR_MODES: readonly EditorMode[] = ["live", "source", "split", "preview"];

export interface UIState {
  // Routing
  route: RouteId;
  // Back/forward stack of primary routes; `route` always sits at `idx`.
  navHistory: NavHistory;
  // Which tab the Feedback page opens on. Not persisted-meaningful state, but
  // it lives here so the activity panel / tray "N awaiting review" row can
  // deep-link straight to the quarantine tab (setRoute alone can't).
  feedbackTab: FeedbackTab;
  // Deck path the Study page should open directly (ritual card's 복습 시작 —
  // Q4 item 11). Same deep-link idiom as feedbackTab, but consumed ONCE:
  // PageStudy reads it on mount and clears it, so later Study visits start at
  // the deck list as usual.
  studyDeck: string | null;
  // Split view: when set, a SECOND pane shows this route beside the primary one
  // (e.g. Overview + Graph side by side). null = single pane.
  splitRoute: RouteId | null;
  // Primary pane's share of the split container (0..1). Clamped at
  // interaction time by clampSplitRatio; sanitized on rehydrate in merge.
  splitRatio: number;
  // Layout
  sidebarCollapsed: boolean;
  // Sidebar Tools disclosure (History … Schedules). Per device — not in the
  // settings bundle.
  toolsOpen: boolean;
  cmdOpen: boolean;
  // Theme & i18n
  lang: Lang;
  theme: Theme;
  density: Density;
  accent: string;
  showCitations: boolean;
  // MYCO mascot master switch — WCAG-style full opt-out (also the 14% of
  // users who reject any character presence). Off = static logo fallback.
  mascotEnabled: boolean;
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
  // Reader properties panel (frontmatter form) folded shut. Default open.
  propsCollapsed: boolean;
  // Reader editor mode; per device, no longer reset per file.
  editorMode: EditorMode;
  // Reader outline pane (headings) shown beside the editor. Per device.
  outlineOpen: boolean;

  setRoute: (route: RouteId) => void;
  /** Route sync after a rename/move: swaps the current entry, no history entry. */
  replaceRoute: (route: RouteId) => void;
  goBack: () => void;
  goForward: () => void;
  setFeedbackTab: (tab: FeedbackTab) => void;
  setStudyDeck: (path: string | null) => void;
  setSplitRoute: (route: RouteId | null) => void;
  setSplitRatio: (ratio: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  toggleTools: () => void;
  setCmdOpen: (v: boolean) => void;
  toggleCmd: () => void;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setAccent: (accent: string) => void;
  setShowCitations: (v: boolean) => void;
  setMascotEnabled: (v: boolean) => void;
  setOverviewTheme: (v: OverviewThemeKey) => void;
  toggleFolder: (id: string) => void;
  setMyceliumGrown: (v: boolean) => void;
  stampVisit: () => void;
  setPropsCollapsed: (v: boolean) => void;
  setEditorMode: (mode: EditorMode) => void;
  toggleOutline: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      route: "overview",
      navHistory: { entries: ["overview"], idx: 0 },
      feedbackTab: "proposals",
      studyDeck: null,
      splitRoute: null,
      splitRatio: SPLIT_DEFAULT_RATIO,
      sidebarCollapsed: false,
      toolsOpen: false,
      cmdOpen: false,
      lang: "ko",
      theme: "dark",
      overviewTheme: DEFAULT_OVERVIEW_THEME,
      density: "comfortable",
      accent: "#181715",
      showCitations: true,
      mascotEnabled: true,
      // Keyed by absolute folder path (synthetic groups by id); all collapsed
      // except Favorites. The old slug-keyed seed never matched real paths.
      expandedFolders: { __favorites: true },
      myceliumGrown: false,
      lastVisitAt: null,
      propsCollapsed: false,
      editorMode: "live",
      outlineOpen: true,

      setRoute: (route) => set((s) => routePatch(s, route, pushRoute(s.navHistory, route))),
      replaceRoute: (route) =>
        set((s) => routePatch(s, route, replaceCurrent(s.navHistory, route))),
      goBack: () => set((s) => stepPatch(s, -1)),
      goForward: () => set((s) => stepPatch(s, 1)),
      setFeedbackTab: (feedbackTab) => set({ feedbackTab }),
      setStudyDeck: (studyDeck) => set({ studyDeck }),
      setSplitRoute: (route) =>
        set((s) => ({ splitRoute: route === s.route ? null : route })),
      setSplitRatio: (ratio) => set({ splitRatio: ratio }),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      toggleTools: () => set({ toolsOpen: !get().toolsOpen }),
      setCmdOpen: (v) => set({ cmdOpen: v }),
      toggleCmd: () => set({ cmdOpen: !get().cmdOpen }),
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setAccent: (accent) => set({ accent }),
      setShowCitations: (v) => set({ showCitations: v }),
      setMascotEnabled: (v) => set({ mascotEnabled: v }),
      setOverviewTheme: (v) => set({ overviewTheme: v }),
      toggleFolder: (id) =>
        set({
          expandedFolders: {
            ...get().expandedFolders,
            // Default must match DirectoryRow's read default (collapsed/false),
            // so the first click reliably expands a not-yet-seen folder.
            [id]: !(get().expandedFolders[id] ?? false),
          },
        }),
      setMyceliumGrown: (v) => set({ myceliumGrown: v }),
      stampVisit: () => set({ lastVisitAt: Date.now() }),
      setPropsCollapsed: (v) => set({ propsCollapsed: v }),
      setEditorMode: (editorMode) => set({ editorMode }),
      toggleOutline: () => set({ outlineOpen: !get().outlineOpen }),
    }),
    {
      name: "myco-ui",
      version: 3,
      // A store persisted before this key existed — or one holding a theme that
      // has since been removed — would otherwise hand the Overview page an
      // engine key with no factory behind it.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UIState>;
        return {
          ...current,
          ...p,
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
          navHistory: sanitizeHistory(p.navHistory, p.route ?? current.route),
          // Favorites default open even for a store persisted before the group existed.
          expandedFolders: { __favorites: true, ...p.expandedFolders },
        };
      },
    },
  ),
);

// Never let the primary and split panes show the SAME route (two live graph
// scenes, duplicate state) — clear the split if it would collide.
function routePatch(s: UIState, route: RouteId, navHistory: NavHistory): Partial<UIState> {
  return { route, navHistory, splitRoute: s.splitRoute === route ? null : s.splitRoute };
}

function stepPatch(s: UIState, delta: -1 | 1): Partial<UIState> {
  const h = step(s.navHistory, delta);
  return h ? routePatch(s, h.entries[h.idx], h) : s;
}
