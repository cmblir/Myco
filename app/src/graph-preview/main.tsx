import React from "react";
import { createRoot } from "react-dom/client";
import { PreviewApp } from "./PreviewApp";
import "./preview.css";

// This separate Vite entry is a review surface, not a replacement for PageGraph.
if (import.meta.env.DEV) {
  const { installTauriMock } = await import("../lib/devMock");
  installTauriMock();
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <PreviewApp />
    </React.StrictMode>,
  );
}
