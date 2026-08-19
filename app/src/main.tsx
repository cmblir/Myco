// Must stay the first import: it renames the legacy `memex.*` storage keys, and
// modules imported below read their key at evaluation time. See storageMigration.ts.
import "./lib/storageMigration";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { isTrayPanelWindow } from "./lib/windowRoute";
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

  // Dev-only: render the UI in a plain browser against an in-memory sample
  // vault (for screenshots / visual QA). Installed BEFORE render so the app's
  // first IPC calls hit the mock. Stripped from production builds.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    const { installTauriMock } = await import("./lib/devMock");
    installTauriMock();
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary reload>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
