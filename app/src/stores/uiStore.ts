// UI store. Holds presentation state that should outlive a single render but
// not require backend round-trips. Persisted to localStorage so window reopens
// keep their configuration.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Lang } from "../lib/i18n";

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
  | "multiverse"
  | "history"
  | "provenance"
  | "tags"
  | "study"
  | "schedules"
  | "settings"
  | `page:${string}`;

export interface UIState {
  // Routing
  route: RouteId;
  // Layout
  sidebarCollapsed: boolean;
  cmdOpen: boolean;
  // Theme & i18n
  lang: Lang;
  theme: Theme;
  density: Density;
  accent: string;
  showCitations: boolean;
  // Sidebar tree
  expandedFolders: Record<string, boolean>;

  setRoute: (route: RouteId) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  setCmdOpen: (v: boolean) => void;
  toggleCmd: () => void;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setAccent: (accent: string) => void;
  setShowCitations: (v: boolean) => void;
  toggleFolder: (id: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      route: "overview",
      sidebarCollapsed: false,
      cmdOpen: false,
      lang: "ko",
      theme: "dark",
      density: "comfortable",
      accent: "#181715",
      showCitations: true,
      // Keyed by absolute folder path; empty by default (all collapsed). The
      // old slug-keyed seed never matched real paths and was inert.
      expandedFolders: {},

      setRoute: (route) => set({ route }),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setCmdOpen: (v) => set({ cmdOpen: v }),
      toggleCmd: () => set({ cmdOpen: !get().cmdOpen }),
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setAccent: (accent) => set({ accent }),
      setShowCitations: (v) => set({ showCitations: v }),
      toggleFolder: (id) =>
        set({
          expandedFolders: {
            ...get().expandedFolders,
            // Default must match DirectoryRow's read default (collapsed/false),
            // so the first click reliably expands a not-yet-seen folder.
            [id]: !(get().expandedFolders[id] ?? false),
          },
        }),
    }),
    { name: "memex-ui", version: 3 },
  ),
);
