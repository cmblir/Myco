import { readFileSync } from "node:fs";
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

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify(buildDate),
    __PACKAGE_VERSION__: JSON.stringify(packageVersion),
  },
  plugins: [react()],
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
