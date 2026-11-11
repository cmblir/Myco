import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MapRefreshHistoryView } from "./MapRefreshHistory";
import { STRINGS } from "../lib/i18n";
import type { MapHistoryRead } from "../lib/mapRefreshHistory";
const render = (read: MapHistoryRead, keys = ["synthetic"]) =>
  renderToStaticMarkup(
    createElement(MapRefreshHistoryView, {
      t: STRINGS.ko,
      keys,
      selected: keys[0] ?? "",
      read,
      onSelect: vi.fn(),
      onReload: vi.fn(),
    }),
  );
it("distinguishes empty, loading, unavailable history and retryable error", () => {
  expect(render({ phase: "idle" }, [])).toContain(
    STRINGS.ko.map_history_no_maps,
  );
  expect(render({ phase: "loading" })).toContain('aria-busy="true"');
  expect(render({ phase: "ready", history: null })).toContain(
    STRINGS.ko.map_history_missing,
  );
  const error = render({ phase: "error", error: "Synthetic failure" });
  expect(error).toContain('role="alert"');
  expect(error).toContain(STRINGS.ko.map_history_reload);
  expect(error).toContain("Synthetic failure");
});
it("labels both immutable snapshots, escapes their content and discloses later edits without offering undo", () => {
  const html = render({
    phase: "ready",
    history: {
      path: "wiki/maps/synthetic.md",
      before: "<script>before</script>",
      after: "Human note preserved",
      hasChangesSinceRefresh: true,
    },
  });
  expect(html).toContain(STRINGS.ko.map_history_before);
  expect(html).toContain(STRINGS.ko.map_history_after);
  expect(html).toContain(STRINGS.ko.map_history_changed);
  expect(html).toContain(STRINGS.ko.map_history_note);
  expect(html).not.toContain("<script>");
  expect(html).toContain("Human note preserved");
});

it("labels a retained-only map without suggesting a new or legacy current file", () => {
  const html = renderToStaticMarkup(
    createElement(MapRefreshHistoryView, {
      t: STRINGS.ko,
      keys: ["deleted-map"],
      selected: "deleted-map",
      retainedOnly: ["deleted-map"],
      read: { phase: "ready", history: null },
      onSelect: vi.fn(),
      onReload: vi.fn(),
    }),
  );
  expect(html).toContain(STRINGS.ko.map_recovery_retained_only);
  expect(html).toContain(STRINGS.ko.map_recovery_missing_file);
  expect(html).not.toContain(STRINGS.ko.map_history_missing);
  expect(html).toMatch(/<button[^>]*disabled/);
});
