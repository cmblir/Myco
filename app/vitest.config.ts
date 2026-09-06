import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests target pure logic (no DOM), so the lightweight node environment is
// enough — no jsdom, no React plugin. If component tests are added later they
// can opt into jsdom per-file via an `// @vitest-environment jsdom` docblock.
export default defineConfig({
  // Same substitution the app build makes (see vite.config.ts): the tests must
  // parse markdown with the language the shipped editor uses.
  resolve: {
    alias: {
      "@codemirror/lang-html": fileURLToPath(
        new URL("./src/lib/langHtmlStub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
