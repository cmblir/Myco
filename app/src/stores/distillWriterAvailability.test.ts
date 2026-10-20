import { describe, expect, it } from "vitest";
import { roleFor } from "../lib/chat";
import type { MycoSettings } from "../lib/ipc";
import { selectedRolesFixture } from "../lib/modelRoles.testSupport";
import { settingsNeedWriter } from "./distillStore";

describe("display-only writer availability without native role selections", () => {
  it("reports a missing role map as unavailable while execution remains refused", () => {
    const settings = {} as MycoSettings;

    expect(() => roleFor("organization", settings)).toThrow(
      "native feature selections are unavailable",
    );
    expect(settingsNeedWriter(settings)).toBe(true);
  });

  it("reports a missing Organization role without borrowing another selected role", () => {
    const modelRoles = selectedRolesFixture({
      ask: { providerId: "anthropic-api", modelId: "synthetic-ask-writer" },
    });
    Reflect.deleteProperty(modelRoles.roles, "organization");
    const settings = { model_roles: modelRoles } as MycoSettings;

    expect(() => roleFor("organization", settings)).toThrow(
      "native feature selections are unavailable",
    );
    expect(settingsNeedWriter(settings)).toBe(true);
  });

  it("does not turn connected legacy external providers into an available writer", () => {
    const settings = {
      providers: {
        anthropic_cli: true,
        gemini_cli: true,
        codex_cli: true,
        anthropic_api: true,
        openai_api: true,
        google_api: true,
        ollama: true,
        openrouter: true,
        myco_pro: true,
        builtin_local: true,
      },
      query_provider: "anthropic-api",
      query_model: "synthetic-legacy-external-writer",
      ingest_provider: "codex-cli",
      ingest_model: "synthetic-legacy-cli-writer",
      query_effort: "(default)",
      ingest_effort: "(default)",
    } as MycoSettings;

    expect(() => roleFor("organization", settings)).toThrow(
      "native feature selections are unavailable",
    );
    expect(settingsNeedWriter(settings)).toBe(true);
  });
});
