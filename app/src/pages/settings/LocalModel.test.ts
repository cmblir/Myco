import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ModelStore from "../../stores/localModelStore";
import {
  BUILTIN_CHAT_MODEL,
  BUILTIN_FAST_CHAT_MODEL,
  BUILTIN_MODEL,
} from "../../lib/providers";
import { localModelCopy } from "../../lib/localModelCopy";
import type { ModelRoleSettings } from "../../lib/modelRoles";
import { selectedRolesFixture } from "../../lib/modelRoles.testSupport";

vi.mock("../../stores/localModelStore", async (load) => {
  const m = await load<typeof ModelStore>();
  const wrap = (store: typeof m.useLocalModelStore) =>
    Object.assign(
      (select: (state: ReturnType<typeof store.getState>) => unknown) =>
        select(store.getState()),
      store,
    );
  return {
    ...m,
    useLocalModelStore: wrap(m.useLocalModelStore),
    useFastLocalModelStore: wrap(m.useFastLocalModelStore),
  };
});
const settings = vi.hoisted(() => ({
  query_provider: "anthropic-cli",
  query_model: "sonnet",
  ingest_provider: "anthropic-cli",
  ingest_model: "haiku",
  model_roles: null as ModelRoleSettings | null,
}));
const update = vi.hoisted(() => vi.fn());
vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ settings, update, saving: false, error: null }),
}));

import { SettingsLocalModel } from "./LocalModel";
import {
  useFastLocalModelStore,
  useLocalModelStore,
} from "../../stores/localModelStore";

const render = (lang: "ko" | "en" | "ja" = "ko") =>
  renderToStaticMarkup(createElement(SettingsLocalModel, { lang }));
const button = (html: string, text: string) =>
  html.match(/<button[^>]*>[^<]*<\/button>/g)?.find((b) => b.includes(text)) ??
  "";

describe("Settings local answer model", () => {
  beforeEach(() => {
    settings.query_provider = "anthropic-cli";
    settings.query_model = "sonnet";
    settings.ingest_provider = "anthropic-cli";
    settings.ingest_model = "haiku";
    settings.model_roles = selectedRolesFixture({ ask: { providerId: "anthropic-cli", modelId: "sonnet" }, compilation: { providerId: "anthropic-cli", modelId: "haiku" } });
    update.mockClear();
    useLocalModelStore.setState({
      stage: "missing",
      error: null,
      cancelling: false,
      pct: 0,
    });
    useFastLocalModelStore.setState({
      stage: "missing",
      error: null,
      cancelling: false,
      pct: 0,
    });
  });

  it("shows an explicit installation action without changing external provider settings", () => {
    const c = localModelCopy("ko");
    const html = render();
    expect(html).toContain('data-srow="model_local_generation"');
    expect(html).toContain(c.missing);
    expect(button(html, c.install)).not.toContain("disabled");
    expect(button(html, c.use)).toContain("disabled");
    expect(update).not.toHaveBeenCalled();
    expect(settings.query_provider).toBe("anthropic-cli");
  });

  it("makes all five states visible with localized recovery actions", () => {
    const c = localModelCopy("ko");
    for (const stage of [
      "checking",
      "missing",
      "downloading",
      "ready",
      "error",
    ] as const) {
      useLocalModelStore.setState({
        stage,
        error: stage === "error" ? "verification failed" : null,
      });
      const html = render();
      expect(html).toContain(c[stage]);
      expect(html).toContain(c.footprint);
      if (stage === "error") {
        expect(html).toContain(c.retry);
        expect(html).toContain(c.details);
      }
    }
  });

  it("shows progress without claiming ready and keeps cancellation busy", () => {
    const c = localModelCopy("ko");
    useLocalModelStore.setState({ stage: "downloading", pct: 40 });
    const html = render();
    expect(html).toContain('aria-label="' + c.progress + '"');
    expect(html).toContain('value="40"');
    expect(button(html, c.cancel)).not.toContain("disabled");
    expect(html).not.toContain(c.ready);
    useLocalModelStore.setState({ cancelling: true });
    const stopping = render();
    expect(stopping).toContain(c.cancelling);
    expect(button(stopping, c.cancel)).toContain("disabled");
  });

  it("offers separate verified synthesis and lightweight quote-only choices", () => {
    const c = localModelCopy("ko");
    useLocalModelStore.setState({ stage: "ready" });
    let html = render();
    expect(button(html, c.use)).not.toContain("disabled");
    expect(button(html, c.quotes)).not.toContain("disabled");
    const roles = settings.model_roles!.roles;
    roles.ask = { ...roles.ask, providerId: "builtin-local", modelId: BUILTIN_CHAT_MODEL, selection: "explicit-local" };
    html = render();
    expect(button(html, c.selected)).toContain("disabled");
    roles.ask.modelId = BUILTIN_MODEL;
    html = render();
    expect(button(html, c.quotesSelected)).toContain("disabled");
  });

  it("does not show preserved legacy values as a selected native role", () => {
    useLocalModelStore.setState({ stage: "ready" });
    settings.query_provider = "builtin-local";
    settings.query_model = BUILTIN_CHAT_MODEL;
    settings.ingest_provider = "builtin-local";
    settings.ingest_model = BUILTIN_CHAT_MODEL;
    const c = localModelCopy("ko");
    const html = render();
    expect(button(html, c.use)).not.toBe("");
    expect(button(html, c.use)).not.toContain("disabled");
    expect(button(html, c.useForIngest)).not.toContain("disabled");
    expect(button(html, c.selected)).toBe("");
    expect(button(html, c.ingestSelected)).toBe("");
  });

  it("uses Korean, English and Japanese copy without a RAM or quality guarantee", () => {
    for (const lang of ["ko", "en", "ja"] as const) {
      const c = localModelCopy(lang);
      const html = render(lang);
      expect(html).toContain(c.title);
      expect(html).toContain(c.lede);
      expect(html).toContain(c.footprint);
      expect(html).toContain("Qwen3.5 4B");
      expect(html).toContain("2.71 GB");
    }
  });

  it("shows 2B availability independently from the ready 4B card", () => {
    useLocalModelStore.setState({ stage: "ready" });
    useFastLocalModelStore.setState({
      stage: "missing",
      pct: 0,
      error: null,
      cancelling: false,
    });
    const c = localModelCopy("ko", BUILTIN_FAST_CHAT_MODEL);
    const html = renderToStaticMarkup(
      createElement(SettingsLocalModel, {
        lang: "ko",
        modelId: BUILTIN_FAST_CHAT_MODEL,
      }),
    );
    expect(html).toContain('data-srow="model_local_generation_fast"');
    expect(html).toContain("Qwen3.5 2B");
    expect(html).toContain("1.27 GB");
    expect(html).toContain(c.missing);
    expect(button(html, c.use)).toContain("disabled");
    expect(button(html, c.useForIngest)).toContain("disabled");
    expect(update).not.toHaveBeenCalled();
  });

  it("marks Ask and ingest choices independently on either installed model", () => {
    useLocalModelStore.setState({ stage: "ready" });
    useFastLocalModelStore.setState({
      stage: "ready",
      error: null,
      cancelling: false,
    });
    settings.model_roles = selectedRolesFixture({ ask: { providerId: "builtin-local", modelId: BUILTIN_FAST_CHAT_MODEL }, compilation: { providerId: "builtin-local", modelId: BUILTIN_CHAT_MODEL } });
    const c = localModelCopy("ko");
    const fast = localModelCopy("ko", BUILTIN_FAST_CHAT_MODEL);
    expect(button(render(), c.use)).not.toContain("disabled");
    expect(button(render(), c.ingestSelected)).toContain("disabled");
    const html = renderToStaticMarkup(
      createElement(SettingsLocalModel, {
        lang: "ko",
        modelId: BUILTIN_FAST_CHAT_MODEL,
      }),
    );
    expect(button(html, fast.selected)).toContain("disabled");
    expect(button(html, fast.useForIngest)).not.toContain("disabled");
  });

  it("disables the other artifact's download while leaving cancellation on its owner", () => {
    useLocalModelStore.setState({ stage: "missing" });
    useFastLocalModelStore.setState({
      stage: "downloading",
      pct: 30,
      error: null,
      cancelling: false,
    });
    expect(button(render(), localModelCopy("ko").install)).toContain(
      "disabled",
    );
    const fast = localModelCopy("ko", BUILTIN_FAST_CHAT_MODEL);
    const html = renderToStaticMarkup(
      createElement(SettingsLocalModel, {
        lang: "ko",
        modelId: BUILTIN_FAST_CHAT_MODEL,
      }),
    );
    expect(html).toContain(fast.downloading);
    expect(button(html, fast.cancel)).not.toContain("disabled");
  });

  it("describes the smaller artifact and bounded local preview without promising speed or an autonomous agent", () => {
    useFastLocalModelStore.setState({
      stage: "missing",
      error: null,
      cancelling: false,
    });
    for (const lang of ["ko", "en", "ja"] as const) {
      const c = localModelCopy(lang, BUILTIN_FAST_CHAT_MODEL);
      const html = renderToStaticMarkup(
        createElement(SettingsLocalModel, {
          lang,
          modelId: BUILTIN_FAST_CHAT_MODEL,
        }),
      );
      expect(html).toContain(c.title);
      expect(html).toContain(c.lede);
      expect(html).toContain(c.use);
      expect(html).toContain(c.useForIngest);
      expect(html).toContain("1.27 GB");
      expect(html).not.toContain("2.71 GB");
      expect(html).not.toMatch(
        /faster|빠르게|더 빠른|高速|fully autonomous|완전 자율/,
      );
      expect(c.lede).toMatch(/experimental|실험적|実験的/);
      expect(c.lede).toMatch(/incorrect relationships|잘못된 관계|誤った関係/);
    }
  });
});
