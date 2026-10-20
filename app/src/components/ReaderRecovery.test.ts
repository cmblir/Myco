// Static React presentation only; clipboard races and native restart need separate gates.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ReaderRecovery, { type ReaderRecoverySnapshot } from "./ReaderRecovery";
import { STRINGS } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";

const original = "---\ntitle: Synthetic first A\n---\nFull original <A> & annotation.\n";
const draft = "---\ntitle: Synthetic draft D\n---\nUnsaved draft D.\n";
const current = "---\ntitle: Synthetic current B\n---\nExternal human B; preserve it.\n";
const snapshot: ReaderRecoverySnapshot = {
  path: "/synthetic/wiki/note.md",
  draft,
  text: draft,
  originalBaseline: original,
  isCurrent: () => true,
  prepare: () => undefined,
  adopt: () => true,
};

function render(overrides: Partial<Parameters<typeof ReaderRecovery>[0]> = {}): string {
  return renderToStaticMarkup(h(ReaderRecovery, {
    t: STRINGS.ko,
    visible: true,
    readOnly: false,
    canCopy: true,
    originalBaseline: original,
    currentFile: current,
    capture: () => snapshot,
    onBusyChange: () => undefined,
    onFeedback: () => undefined,
    ...overrides,
  }));
}

describe("reader recovery original and current file", () => {
  it("shows the complete first baseline and current human file as escaped read-only disclosures", () => {
    const html = render();
    expect(html).toContain(`<summary>${STRINGS.ko.rd_original_baseline}</summary>`);
    expect(html).toContain(`<pre>---\ntitle: Synthetic first A\n---\nFull original &lt;A&gt; &amp; annotation.\n</pre>`);
    expect(html).toContain(`<summary>${STRINGS.ko.rd_current_file}</summary>`);
    expect(html).toContain(`<pre>${current}</pre>`);
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("contenteditable");
    expect(html).not.toContain(draft);
  });

  it("keeps draft copy, baseline copy and explicit reload as distinct keyboard controls", () => {
    const html = render();
    expect(html).toContain(STRINGS.ko.rd_copy_draft);
    expect(html).toContain(STRINGS.ko.rd_copy_baseline);
    expect(html).toContain(STRINGS.ko.rd_reload_draft);
    expect(html.match(/<button type="button"/g)).toHaveLength(3);
    expect(html).not.toContain('tabindex="-1"');
    expect(html).not.toContain(STRINGS.ko.rd_saved);
  });

  it("does not invent a first baseline when none is available", () => {
    const html = render({ originalBaseline: undefined });
    expect(html).not.toContain(STRINGS.ko.rd_original_baseline);
    expect(html).not.toContain(STRINGS.ko.rd_copy_baseline);
    expect(html).toContain(STRINGS.ko.rd_copy_draft);
    expect(html).toContain(current);
  });

  it("preserves an empty full baseline instead of treating it as absent", () => {
    const html = render({ originalBaseline: "" });
    expect(html).toContain(STRINGS.ko.rd_original_baseline);
    expect(html).toContain(STRINGS.ko.rd_copy_baseline);
    expect(html).toContain("<pre></pre>");
  });

  it("offers no destructive reload for raw read-only files", () => {
    const html = render({ readOnly: true });
    expect(html).not.toContain(STRINGS.ko.rd_reload_draft);
    expect(html).toContain(STRINGS.ko.rd_copy_draft);
  });

  it("disables both copy controls when the reader cannot safely capture them", () => {
    const html = render({ canCopy: false });
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  });

  it("has no disclosures or capture side effects outside recovery", () => {
    const capture = vi.fn(() => snapshot);
    expect(render({ visible: false, capture })).toBe("");
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("reader recovery after a failed current read", () => {
  it("offers read-only escaped A and D copies and a harmless file-read retry without cached B", () => {
    const recoveryDraft = "Unsaved <D> & synthetic annotation.\n";
    const html = render({
      readOnly: true,
      recoveryDraft,
      currentFile: undefined,
      onRetryRead: async () => undefined,
    });
    expect(html).toContain(`<summary>${STRINGS.ko.rd_original_baseline}</summary>`);
    expect(html).toContain(`<summary>${STRINGS.ko.rd_recovery_draft}</summary>`);
    expect(html).toContain("<pre>Unsaved &lt;D&gt; &amp; synthetic annotation.\n</pre>");
    expect(html).toContain(STRINGS.ko.rd_copy_draft);
    expect(html).toContain(STRINGS.ko.rd_copy_baseline);
    expect(html).toContain(STRINGS.ko.rd_retry_file_read);
    expect(html.match(/<button type="button"/g)).toHaveLength(3);
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).not.toContain(STRINGS.ko.rd_current_file);
    expect(html).not.toContain(current);
    expect(html).not.toContain(STRINGS.ko.rd_reload_draft);
    expect(html).not.toContain(STRINGS.ko.rd_recovered_draft);
    expect(html).not.toContain(STRINGS.ko.rd_saved);
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("contenteditable");
  });

  it("preserves an empty D as available read-only recovery text with a copy control", () => {
    const html = render({
      readOnly: true,
      recoveryDraft: "",
      currentFile: undefined,
      onRetryRead: async () => undefined,
    });
    expect(html).toContain(STRINGS.ko.rd_recovery_draft);
    expect(html).toContain(STRINGS.ko.rd_copy_draft);
    expect(html).toContain("<pre></pre>");
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toContain(STRINGS.ko.rd_current_file);
  });

  it("offers copies only for available recovery text after a failed read", () => {
    const html = render({
      readOnly: true,
      originalBaseline: undefined,
      recoveryDraft: undefined,
      currentFile: undefined,
      canCopy: false,
      onRetryRead: async () => undefined,
    });
    expect(html).toContain(STRINGS.ko.rd_retry_file_read);
    expect(html.match(/<button type="button"/g)).toHaveLength(1);
    expect(html).not.toContain(STRINGS.ko.rd_copy_draft);
    expect(html).not.toContain(STRINGS.ko.rd_copy_baseline);
    expect(html).not.toContain("<details");
  });

  it("does not capture, retry, save, stage or acquire recovery authority while rendering", () => {
    const capture = vi.fn(() => snapshot);
    const onRetryRead = vi.fn(async () => undefined);
    const onBusyChange = vi.fn();
    const onFeedback = vi.fn();
    const vault = useVaultStore.getState();
    const actions = [
      vi.spyOn(vault, "openFile"),
      vi.spyOn(vault, "saveFile"),
      vi.spyOn(vault, "persistPendingEditorDraft"),
      vi.spyOn(vault, "recoverEditorFile"),
    ];
    try {
      render({
        readOnly: true,
        recoveryDraft: draft,
        currentFile: undefined,
        capture, onRetryRead, onBusyChange, onFeedback,
      });
      expect(capture).not.toHaveBeenCalled();
      expect(onRetryRead).not.toHaveBeenCalled();
      expect(onBusyChange).not.toHaveBeenCalled();
      expect(onFeedback).not.toHaveBeenCalled();
      for (const action of actions) expect(action).not.toHaveBeenCalled();
    } finally {
      for (const action of actions) action.mockRestore();
    }
  });
});
