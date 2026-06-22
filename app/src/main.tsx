import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";

async function bootstrap(): Promise<void> {
  // Dev-only: render the UI in a plain browser against an in-memory sample
  // vault (for screenshots / visual QA). Installed BEFORE render so the app's
  // first IPC calls hit the mock. Stripped from production builds.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    const { installTauriMock } = await import("./lib/devMock");
    installTauriMock();
  }

  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Root element #root not found in index.html");
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
