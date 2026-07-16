import { lazy, Suspense, useEffect, useState } from "react";
import type { JSX } from "react";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import CommandBar from "./components/CommandBar";
import DialogHost from "./components/DialogHost";
import ErrorBoundary from "./components/ErrorBoundary";
import OnboardingWizard from "./components/OnboardingWizard";
import MascotClip from "./components/MascotClip";
import HelpWidget from "./components/HelpWidget";
import PageOverview from "./pages/PageOverview";
import PageIngest from "./pages/PageIngest";
import PageQuery from "./pages/PageQuery";
// Lazy — the 3D graph pulls in three.js (~150KB gzip); keep it out of the
// initial bundle so the app boots under the JS budget and loads it on demand.
const PageGraph = lazy(() => import("./pages/PageGraph"));
import PageHistory from "./pages/PageHistory";
import PageProvenance from "./pages/PageProvenance";
import PageSettings from "./pages/PageSettings";
import PageReader from "./pages/PageReader";
import PageTags from "./pages/PageTags";
import PageViews from "./pages/PageViews";
import PageStudy from "./pages/PageStudy";
import PageSchedules from "./pages/PageSchedules";
import { STRINGS } from "./lib/i18n";
import { useUIStore } from "./stores/uiStore";
import { useSettingsStore } from "./stores/settingsStore";
import { getLastVaultPath, useVaultStore } from "./stores/vaultStore";
import { useAutoIngestScheduler } from "./lib/autoIngest";
import { useAutoReflectScheduler } from "./lib/autoReflect";
import { useScheduleTimer } from "./lib/scheduleTimer";
import { useIngestStore } from "./stores/ingestStore";
import { ipc } from "./lib/ipc";
import type { FileNode } from "./lib/ipc";

const ONBOARDED_KEY = "memex.onboarded";

function countPages(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === "file") {
      if (node.name.endsWith(".md")) n++;
    } else {
      n += countPages(node.children);
    }
  }
  return n;
}

// Matches the seeded accent in uiStore. While it's the active value we let the
// [data-theme] stylesheet own --accent instead of overriding it inline.
const DEFAULT_ACCENT = "#181715";

export default function App(): JSX.Element {
  const route = useUIStore((s) => s.route);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const lang = useUIStore((s) => s.lang);
  const theme = useUIStore((s) => s.theme);
  const density = useUIStore((s) => s.density);
  const accent = useUIStore((s) => s.accent);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const currentVault = useVaultStore((s) => s.currentVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const openVault = useVaultStore((s) => s.openVault);
  const loadSettings = useSettingsStore((s) => s.load);
  const settings = useSettingsStore((s) => s.settings);

  const t = STRINGS[lang] ?? STRINGS.en;

  // First-run onboarding (UX-01). Persist a dismissible flag so the wizard
  // never reappears once completed or skipped. `bootDone` gates the overlay so
  // it can't flash during the initial async vault-open below.
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ONBOARDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [bootDone, setBootDone] = useState(false);
  function completeOnboarding(): void {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      /* localStorage unavailable */
    }
    setOnboarded(true);
  }
  // Genuine first run: nothing opened, or an empty vault (no markdown pages).
  const firstRun =
    bootDone && !onboarded && (!currentVault || countPages(fileTree) === 0);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Scheduled auto-ingest of the vault's _inbox/ while the app is open.
  useAutoIngestScheduler(
    settings?.auto_ingest_enabled ?? false,
    settings?.auto_ingest_interval_min ?? 60,
    currentVault?.path,
  );

  // Scheduled read-only reflect pass while the app is open (FEAT-06).
  useAutoReflectScheduler(
    settings?.auto_reflect_enabled ?? false,
    settings?.auto_reflect_interval_min ?? 180,
    currentVault?.path,
  );

  // Recurring digest schedules while the app is open (Feature 7).
  useScheduleTimer(currentVault?.path);

  // Auto-refresh the file tree + link graph so EXTERNAL changes (edits in
  // Obsidian/Finder, files written outside in-app operations) appear without a
  // restart. Triggers: window focus, the tab becoming visible, and a gentle
  // poll while visible. The vaultStore guards skip the commit when nothing
  // changed, so this never churns the sidebar or rebuilds the 3D graph. Paused
  // while an ingest run is active — that flow drives its own live updates and a
  // mid-run adjacency swap would tear the graph down.
  const currentVaultPath = currentVault?.path ?? null;
  useEffect(() => {
    if (!currentVaultPath) return;
    const INGEST_RUNNING = ["writing-raw", "claude", "indexing"];
    const refresh = (): void => {
      if (document.visibilityState !== "visible") return;
      if (INGEST_RUNNING.includes(useIngestStore.getState().stage)) return;
      const v = useVaultStore.getState();
      void v.refreshTree();
      void v.refreshLinkGraph();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(refresh, 4000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(id);
    };
  }, [currentVaultPath]);

  // Web clipper: the Rust deep-link handler saved a clip into _inbox/ and
  // emitted this event — refresh so the new source doc appears immediately.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("memex://clip-saved", () => {
          const v = useVaultStore.getState();
          void v.refreshTree();
        }),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Track the OS colour scheme live so the "System" appearance option follows
  // light/dark changes at runtime (not just on app launch).
  const [sysDark, setSysDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => setSysDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const effectiveTheme =
    theme === "system" ? (sysDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    const r = document.documentElement;
    if (density === "compact") {
      r.style.setProperty("--top-h", "40px");
      r.style.setProperty("--side-w", "240px");
      document.body.style.fontSize = "13px";
    } else if (density === "spacious") {
      r.style.setProperty("--top-h", "52px");
      r.style.setProperty("--side-w", "280px");
      document.body.style.fontSize = "15px";
    } else {
      r.style.setProperty("--top-h", "44px");
      r.style.setProperty("--side-w", "264px");
      document.body.style.fontSize = "14px";
    }
  }, [density]);

  useEffect(() => {
    const el = document.documentElement;
    // Only override the theme's --accent when the user actually picked a custom
    // accent. Otherwise the seeded default (#181715) would clobber the dark
    // theme's --accent and render accent-on-accent UI (e.g. the timelapse play
    // button) invisible.
    if (accent && accent.toLowerCase() !== DEFAULT_ACCENT) {
      el.style.setProperty("--accent", accent);
    } else {
      el.style.removeProperty("--accent");
    }
  }, [accent]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleCmd();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCmd, toggleSidebar]);

  // Responsive sidebar: below 768px the sidebar is an off-canvas overlay, so it
  // must default to collapsed. Collapse when starting narrow (but don't force-
  // expand a persisted manual collapse on a wide screen), and snap to the size-
  // appropriate default whenever the viewport crosses the breakpoint.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    if (mq.matches) setSidebarCollapsed(true);
    const onChange = (e: MediaQueryListEvent): void =>
      setSidebarCollapsed(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [setSidebarCollapsed]);

  // On a small screen, close the overlay sidebar after navigating to a route.
  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) {
      setSidebarCollapsed(true);
    }
  }, [route, setSidebarCollapsed]);

  // Auto-restore or create default vault on first mount.
  //
  // We always run ensureDefaultVault first — it's idempotent and seeds
  // the canonical ~/Documents/Memex scaffold. This repairs any missing
  // subdirectories or seed files (e.g. if the user manually deleted
  // raw/ from Finder).
  //
  // Then we open the user's last vault if any (which may be the default
  // OR an external folder like an existing Obsidian vault). If the
  // saved path no longer exists, fall through to the default so the
  // app is never stuck without a vault.
  useEffect(() => {
    if (currentVault) {
      setBootDone(true);
      return;
    }
    void (async () => {
      try {
        // Dev-only escape hatch — `?vault=/some/path` lets us point the
        // app at an arbitrary directory for quick visual testing.
        const urlVault = new URLSearchParams(window.location.search).get(
          "vault",
        );
        if (urlVault) {
          await openVault(urlVault);
          if (useVaultStore.getState().currentVault) return;
        }
        let defaultVault: string | null = null;
        try {
          defaultVault = await ipc.ensureDefaultVault();
        } catch {
          /* keep going — user may have a different vault saved */
        }
        const last = getLastVaultPath();
        if (last) {
          await openVault(last);
          if (useVaultStore.getState().currentVault) return;
        }
        if (defaultVault) {
          await openVault(defaultVault);
        }
      } finally {
        // Whatever the outcome, the initial vault-open attempt has settled —
        // now it's safe to evaluate first-run for the onboarding overlay.
        setBootDone(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let body: JSX.Element;
  if (route === "overview") body = <PageOverview t={t} />;
  else if (route === "ingest") body = <PageIngest t={t} />;
  else if (route === "query") body = <PageQuery t={t} />;
  else if (route === "graph")
    body = (
      <ErrorBoundary area="the graph">
        {/* The three.js chunk is ~800KB — the parse gap used to be a BLANK
            pane on the marquee view. Reuse the constellation tip so the wait
            reads as part of the show. */}
        <Suspense
          fallback={
            <div className="graph-loading">
              <div className="graph-loading-tip">
                {/* MYCO keeps the chunk-parse gap company. */}
                <div style={{ display: "grid", justifyItems: "center", gap: 12 }}>
                  <MascotClip clip="idle" size={140} />
                  <span>{t.gr_loading ?? "aligning constellations…"}</span>
                </div>
              </div>
            </div>
          }
        >
          <PageGraph t={t} />
        </Suspense>
      </ErrorBoundary>
    );
  else if (route === "history") body = <PageHistory t={t} />;
  else if (route === "provenance") body = <PageProvenance t={t} />;
  else if (route === "tags") body = <PageTags t={t} />;
  else if (route === "views") body = <PageViews t={t} />;
  else if (route === "study") body = <PageStudy t={t} />;
  else if (route === "schedules") body = <PageSchedules t={t} />;
  else if (route === "settings") body = <PageSettings t={t} />;
  else if (route.startsWith("page:"))
    body = <PageReader t={t} pageRoute={route.slice(5)} />;
  else body = <PageOverview t={t} />;

  return (
    <div className={"app" + (sidebarCollapsed ? " sidebar-collapsed" : "")}>
      <Sidebar t={t} />
      {/* Backdrop for the mobile sidebar overlay; tap to close. Hidden on
          desktop and when the sidebar is collapsed (see styles.css). */}
      <button
        className="sidebar-scrim"
        aria-label="Close sidebar"
        tabIndex={-1}
        onClick={() => setSidebarCollapsed(true)}
      />
      <main>
        <Topbar t={t} />
        {body}
      </main>
      <CommandBar t={t} />
      <DialogHost />
      <HelpWidget t={t} />
      {firstRun ? (
        <OnboardingWizard t={t} onClose={completeOnboarding} />
      ) : null}
    </div>
  );
}
