// Settings → Model's model cards as static markup (node, no DOM), as
// Plugins.test.ts does.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPicker } from "./Model";
import { STRINGS } from "../../lib/i18n";
import { PROVIDERS, RECOMMENDED_MODEL } from "../../lib/providers";

const t = STRINGS.ko;
const byId = (...ids: string[]) => PROVIDERS.filter((p) => ids.includes(p.id));
const render = (
  pick: { provider: string; model: string; effort: string },
  providers = byId("builtin-local", "anthropic-cli", "codex-cli"),
): string =>
  renderToStaticMarkup(
    createElement(ModelPicker, {
      t,
      role: "query",
      rowId: "model_query",
      label: t.s_model_query,
      providers,
      ...pick,
      onPick: () => undefined,
      onPickEffort: () => undefined,
    }),
  );
const radio = (html: string, text: string): string =>
  html.match(new RegExp(`<label[^>]*><input[^>]*>${text}</label>`))?.[0] ?? "";

describe("Settings → Model card", () => {
  it("keeps the local recommendation selectable without any external account", () => {
    const html = render(RECOMMENDED_MODEL.query, []);
    expect(radio(html, t.s_model_use_recommended)).not.toBe("");
    expect(radio(html, t.s_model_use_recommended)).not.toMatch(/disabled/);
    expect(html).not.toContain(t.s_model_recommended_needs);
    expect(html).toContain(`${RECOMMENDED_MODEL.query.provider} · ${RECOMMENDED_MODEL.query.model}`);
  });

  it("can return an explicit external choice to the local recommendation without connecting Claude", () => {
    const html = render({ provider: "codex-cli", model: "gpt-5.5", effort: "(default)" }, byId("codex-cli"));
    expect(radio(html, t.s_model_use_recommended)).not.toBe("");
    expect(radio(html, t.s_model_use_recommended)).not.toMatch(/disabled/);
    expect(radio(html, t.s_model_choose_own)).toMatch(/checked/);
    expect(html).not.toContain(t.s_model_recommended_needs);
  });

  it("on the recommended setting, hides the selects", () => {
    const html = render(RECOMMENDED_MODEL.query);
    expect(radio(html, t.s_model_use_recommended)).toMatch(/checked/);
    expect(radio(html, t.s_model_choose_own)).not.toMatch(/checked/);
    expect(html).not.toContain("<select");
    // The header still names what runs.
    expect(html).toContain(`${RECOMMENDED_MODEL.query.provider} · ${RECOMMENDED_MODEL.query.model}`);
  });

  it("on any other pick, opens on Choose myself with the selects", () => {
    const html = render({
      provider: "codex-cli",
      model: "gpt-5.5",
      effort: "(default)",
    });
    expect(radio(html, t.s_model_choose_own)).toMatch(/checked/);
    expect(radio(html, t.s_model_use_recommended)).not.toMatch(/checked/);
    expect(html).toContain("<select");
  });

  it("does not treat disconnected external providers as a local execution prerequisite", () => {
    const html = render(
      { provider: "codex-cli", model: "gpt-5.5", effort: "(default)" },
      byId("codex-cli"),
    );
    expect(radio(html, t.s_model_use_recommended)).not.toMatch(/disabled/);
    expect(html).not.toContain(t.s_model_recommended_needs);
  });
});
