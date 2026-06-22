import { defineConfig } from "vitest/config";

// Unit tests target pure logic (no DOM), so the lightweight node environment is
// enough — no jsdom, no React plugin. If component tests are added later they
// can opt into jsdom per-file via an `// @vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
