import { describe, expect, it } from "vitest";
import { PROVIDERS } from "./providers";

// Regression guard for the Model-tab bug where a connected CLI provider's
// dropdown showed only the "(default)" sentinel with nothing else to pick
// (codex-cli's catalog used to be `["(default)"]`). Every CLI provider must
// offer at least one real, invocable model alongside "(default)".
describe("CLI provider catalogs", () => {
  const cliProviders = PROVIDERS.filter((p) => p.kind === "cli");

  it("covers all three CLI providers", () => {
    expect(cliProviders.map((p) => p.id).sort()).toEqual([
      "anthropic-cli",
      "codex-cli",
      "gemini-cli",
    ]);
  });

  it.each(cliProviders)(
    "$id offers a real model, not just \"(default)\"",
    (def) => {
      const realModels = (def.catalog ?? []).filter((m) => m !== "(default)");
      expect(realModels.length).toBeGreaterThan(0);
    },
  );
});
