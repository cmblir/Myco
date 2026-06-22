import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri injects TAURI_PLATFORM and friends; treat them as build-time hints only.
const tauriHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
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
