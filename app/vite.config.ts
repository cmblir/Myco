import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri injects TAURI_PLATFORM and friends; treat them as build-time hints only.
const tauriHost = process.env.TAURI_DEV_HOST;

// The About card's build date. There is no other source for it — the version
// itself comes from tauri.conf.json at runtime via getVersion().
const buildDate = new Date().toISOString().slice(0, 10);

// Fallback for the About card when the app runs in a plain browser (dev mock,
// screenshots) and there is no Tauri host to ask for the bundle version.
const packageVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version as string;

// Does this build have an updater signing pubkey baked in? Without one the
// updater can only ever fail signature verification, so the UI says "no update
// channel configured" instead of pretending to check. Read from the very file
// the bundler signs against, so the two cannot drift.
const updaterConfigured = Boolean(
  (
    JSON.parse(
      readFileSync(
        new URL("./src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
    ) as { plugins?: { updater?: { pubkey?: string } } }
  ).plugins?.updater?.pubkey,
);

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify(buildDate),
    __PACKAGE_VERSION__: JSON.stringify(packageVersion),
    __UPDATER_CONFIGURED__: JSON.stringify(updaterConfigured),
  },
  plugins: [react(), ...(process.env.VITE_MYCO_REAL_DIAG === "1" ? [{
    name: "real-record-diagnostic-capture",
    configureServer(server: import("vite").ViteDevServer) {
      // Debug-only local tokenizer bridge, pinned to the same selected model
      // service as native generation. This does not serve report files.
      server.middlewares.use("/__myco_tokenize", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const response = await fetch("http://127.0.0.1:11435/api/myco-tokenize", {
              method: "POST", headers: { "Content-Type": "application/json" }, body,
            });
            res.statusCode = response.status;
            res.setHeader("Content-Type", "application/json");
            res.end(await response.text());
          } catch { res.statusCode = 502; res.end("tokenizer unavailable"); }
        });
      });
      // The frozen cases are real questions: read from a local file named by
      // the run, never kept in source.
      server.middlewares.use("/__myco_diag_cases", (req, res) => {
        const file = process.env.MYCO_REAL_DIAG_CASES;
        if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
        if (!file) { res.statusCode = 503; res.end("MYCO_REAL_DIAG_CASES is not set"); return; }
        try { res.setHeader("Content-Type", "application/json"); res.end(readFileSync(file, "utf8")); }
        catch { res.statusCode = 500; res.end("case file unreadable"); }
      });
      server.middlewares.use("/__myco_diag", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          try {
            const entry = JSON.parse(body);
            // The capture file is named by the diagnostic run, never in source.
            const out = process.env.MYCO_REAL_DIAG_OUT;
            if (!out) { res.statusCode = 503; res.end("MYCO_REAL_DIAG_OUT is not set"); return; }
            appendFileSync(out, JSON.stringify({ capturedUtc: new Date().toISOString(), ...entry }) + "\n");
            res.end("ok");
          } catch { res.statusCode = 400; res.end("invalid capture"); }
        });
      });
    },
  }] : [])],
  // `@codemirror/lang-markdown` statically imports `@codemirror/lang-html`
  // (HTML-in-markdown: tag completion + nested parsing), which drags the
  // @lezer html/css/javascript grammars along — 167 kB minified, measured.
  // The reader uses none of it, so lang-html resolves to a no-op stub. Kept
  // identical in vitest.config.ts: tests must run what ships.
  resolve: {
    alias: {
      "@codemirror/lang-html": fileURLToPath(
        new URL("./src/lib/langHtmlStub.ts", import.meta.url),
      ),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: tauriHost ?? false,
    hmr: tauriHost
      ? { protocol: "ws", host: tauriHost, port: 5174 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    sourcemap: false,
    minify: "esbuild",
    chunkSizeWarningLimit: 1600,
  },
});
