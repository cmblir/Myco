// Must stay the first import: it renames the legacy `memex.*` storage keys, and
// modules imported below read their key at evaluation time. See storageMigration.ts.
import "./lib/storageMigration";
import React from "react";
import ReactDOM from "react-dom/client";
import ErrorBoundary from "./components/ErrorBoundary";
import {
  isNotchWindow,
  isSpotlightWindow,
  isTrayPanelWindow,
} from "./lib/windowRoute";
import "./styles.css";

const ERROR_LOG_KEY = "myco.errorlog";
const ERROR_LOG_MAX = 20;

// Ring-buffer the last N uncaught errors into localStorage so crashes leave a
// trace that survives a reload (there is no remote telemetry). Must never
// throw itself — localStorage can be unavailable or full.
function recordGlobalError(kind: string, message: string): void {
  console.error(`[memex:${kind}]`, message);
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ERROR_LOG_KEY) ?? "[]");
    const entries = Array.isArray(parsed) ? parsed : [];
    entries.push({ ts: new Date().toISOString(), kind, message });
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(entries.slice(-ERROR_LOG_MAX)));
  } catch {
    // Persisting the error log is best-effort; the console.error above stands.
  }
}

async function bootstrap(): Promise<void> {
  // Global crash surfaces: React's ErrorBoundary only catches render errors,
  // so uncaught exceptions and promise rejections are logged here.
  window.addEventListener("error", (event) => {
    recordGlobalError("error", event.message || String(event.error));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    recordGlobalError(
      "unhandledrejection",
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    );
  });

  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Root element #root not found in index.html");
  }

  // Dev-only: render the UI in a plain browser against an in-memory sample
  // vault (for screenshots / visual QA). Installed BEFORE any render — the
  // tray-panel branch below included, so ?window=tray&mock=1 exercises the
  // real getTrayStatus path against the mock rather than needing a bespoke
  // fixture. Stripped from production builds.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    const { installTauriMock } = await import("./lib/devMock");
    installTauriMock();
  }

  // The tray popover window (Rust opens index.html?window=tray) renders ONLY
  // the activity panel — App and its schedulers never mount in that context.
  if (isTrayPanelWindow(location.search)) {
    const { default: TrayPanel } = await import("./components/TrayPanel");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <TrayPanel />
        </ErrorBoundary>
      </React.StrictMode>,
    );
    return;
  }

  // The global-shortcut spotlight (Rust opens index.html?window=spotlight):
  // one input and the answer. Like the tray window, App never mounts here, so
  // none of its schedulers run in this third JS context — and the question is
  // answered by the main window, not here (see lib/spotlight.ts).
  if (isSpotlightWindow(location.search)) {
    const { default: Spotlight } = await import("./components/Spotlight");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <Spotlight />
        </ErrorBoundary>
      </React.StrictMode>,
    );
    return;
  }

  // The menu-bar notch surface (`index.html?window=notch`): the drop target and
  // its run HUD. Like the two above, App never mounts here. The driver feeds
  // the panel real state (drag-drop, tray-status pushes, window sizing) and
  // stands down under `?window=notch&notchMock=1`, where the panel's own dev
  // walk still cycles the ten states in a plain browser.
  if (isNotchWindow(location.search)) {
    const [{ default: NotchPanel }, { useNotchDriver }] = await Promise.all([
      import("./components/NotchPanel"),
      import("./lib/notchDriver"),
    ]);
    function NotchHost(): React.JSX.Element {
      const drive = useNotchDriver();
      if (!drive) return <NotchPanel />;
      return (
        <NotchPanel
          state={drive.state}
          pill={drive.pill}
          collapsedWidth={drive.collapsedWidth}
          onCaptureSubmit={drive.onCaptureSubmit}
          onCaptureCancel={drive.onCaptureCancel}
          onCaptureVoice={drive.onCaptureVoice}
          onCaptureOpen={drive.onCaptureOpen}
          onRecordStop={drive.onRecordStop}
          onCapturePaste={drive.onCapturePaste}
          levels={drive.levels}
        />
      );
    }
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <NotchHost />
        </ErrorBoundary>
      </React.StrictMode>,
    );
    return;
  }

  // Only the main window needs App, so it is imported here, not at the top: a
  // static import put App's whole module graph into the entry chunk, and the
  // three satellite windows above load that same entry for their 7–9 kB of
  // own code (entry 2,116 kB → 319 kB with this dynamic import). The ordering
  // guarantees hold as before: storageMigration and ErrorBoundary evaluate at
  // module load, App's graph only when this import resolves.
  const { default: App } = await import("./App");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary reload>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
