// Static presentation only; effects, native authorization and layout need separate checks.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionCompileQueueView } from "./SessionCompileQueue";
import { STRINGS } from "../lib/i18n";
import type { SessionQueueRead } from "../lib/sessionCompileQueue";
import type { SessionQueueItem } from "../lib/ipc";

const opening = { vaultPath: "/synthetic-queue", vaultToken: "synthetic-ui-1" };
const origin = {
  vaultPath: opening.vaultPath,
  openingToken: "synthetic-native-1",
};
const row: SessionQueueItem = {
  key: "codex:synthetic",
  rawPath: "raw/conversations/codex/synthetic.md",
  sourceRevision: "a".repeat(64),
  title: "Synthetic first",
  srcSlug: "src-synthetic",
  summaryPath: null,
  compileJobId: "synthetic-duplicate-id",
  compilationState: "pending",
  compilationReason: "compiler_runtime_revalidation_required",
};
function render(read: SessionQueueRead) {
  return renderToStaticMarkup(
    h(SessionCompileQueueView, {
      t: STRINGS.ko,
      lang: "ko",
      read,
      onRefresh: vi.fn(),
    }),
  );
}
describe("session compile queue presentation", () => {
  it("shows idle, loading, empty, error and populated observations distinctly", () => {
    const idle = render({ phase: "idle" });
    expect(idle).toContain(STRINGS.ko.session_queue_idle);
    expect(idle).toContain("disabled");
    const loading = render({ phase: "loading", ...opening });
    expect(loading).toContain(STRINGS.ko.st_loading);
    expect(loading).toContain('aria-busy="true"');
    const empty = render({
      phase: "ready",
      ...opening,
      origin,
      view: { pendingTotal: 0, items: [] },
    });
    expect(empty).toContain(STRINGS.ko.session_queue_empty);
    expect(empty).not.toContain("session-compile-queue-row");
    const failure = render({
      phase: "error",
      ...opening,
      error: "Synthetic queue read failure",
    });
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("Synthetic queue read failure");
    expect(failure).toContain(STRINGS.ko.session_queue_refresh);
    expect(failure).not.toContain("disabled");
  });
  it("shows total and displayed counts separately and preserves duplicate-ID rows", () => {
    const html = render({
      phase: "ready",
      ...opening,
      origin,
      view: {
        pendingTotal: 8,
        items: [
          row,
          { ...row, title: "Synthetic second", compilationState: "partial" },
          {
            ...row,
            title: "Synthetic third",
            compilationState: "failed",
            compilationReason: "processing_failed",
          },
        ],
      },
    });
    expect(html).toContain(
      STRINGS.ko.session_queue_count
        .replace("{total}", "8")
        .replace("{shown}", "3"),
    );
    expect(html.match(/data-testid="session-compile-queue-row"/g)).toHaveLength(
      3,
    );
    expect(html).toContain("Synthetic first");
    expect(html).toContain("Synthetic second");
    expect(html).toContain("Synthetic third");
    expect(html).toContain(STRINGS.ko.workflow_partial);
    expect(html).toContain(STRINGS.ko.workflow_failed);
    expect(html).toContain(STRINGS.ko.session_queue_runtime_review);
    expect(html).not.toContain(STRINGS.ko.ing_success_title);
  });
  it("shows native reasons as escaped text without inventing completion or progress", () => {
    const html = render({
      phase: "ready",
      ...opening,
      origin,
      view: {
        pendingTotal: 1,
        items: [
          {
            ...row,
            title: "<img src=x>",
            compilationState: "stopped",
            compilationReason: "<script>Synthetic reason</script>",
          },
        ],
      },
    });
    expect(html).toContain(STRINGS.ko.workflow_stopped);
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("&lt;script&gt;Synthetic reason&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("처리한 구간");
    expect(html).not.toContain(STRINGS.ko.ing_success_title);
  });
  it("keeps the refresh action and reason disclosure semantic and has no run actions", () => {
    const html = render({
      phase: "ready",
      ...opening,
      origin,
      view: { pendingTotal: 1, items: [row] },
    });
    expect(html).toContain('type="button"');
    expect(html).toContain("aria-labelledby");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<summary>");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
  it("keeps a missing native state unknown instead of inventing Pending", () => {
    const html = render({
      phase: "ready",
      ...opening,
      origin,
      view: {
        pendingTotal: 1,
        items: [{ ...row, compilationState: undefined }],
      },
    });
    expect(html).toContain(STRINGS.ko.session_queue_unknown);
    expect(html).not.toContain(STRINGS.ko.workflow_pending);
  });
  it.each([
    ["native_compilation_or_review_incomplete", "session_queue_incomplete"],
    ["semantic_review_unavailable", "session_queue_incomplete"],
    ["model_host_failed", "session_queue_model_failed"],
    ["processing_failed", "session_queue_processing_failed"],
    ["task_failed", "session_queue_processing_failed"],
    [
      "compiler_role_revalidation_required: synthetic route detail",
      "session_queue_conditions_review",
    ],
  ] as const)(
    "explains native %s without changing its state",
    (compilationReason, label) => {
      const html = render({
        phase: "ready",
        ...opening,
        origin,
        view: {
          pendingTotal: 1,
          items: [{ ...row, compilationState: "partial", compilationReason }],
        },
      });
      expect(html).toContain(STRINGS.ko[label]);
      expect(html).toContain(STRINGS.ko.workflow_partial);
      expect(html).toContain(compilationReason);
    },
  );
  it("preparation reasons do not impose a local model or paid connection", () => {
    for (const compilationReason of [
      "model_preparation_unavailable",
      "preparation_required",
    ]) {
      const html = render({
        phase: "ready",
        ...opening,
        origin,
        view: { pendingTotal: 1, items: [{ ...row, compilationReason }] },
      });
      expect(html).toContain(STRINGS.ko.session_queue_preparation);
      expect(html).not.toContain(STRINGS.ko.session_compile_preparation);
    }
  });
});
