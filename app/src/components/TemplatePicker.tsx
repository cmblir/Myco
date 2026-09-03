// "New note from template…" — a pick dialog listing templates/*.md, or an
// empty state that creates the two localized starters. Sidebar context menu
// and ⌘K both funnel here.

import { useState } from "react";
import type { JSX } from "react";
import {
  confirmAction,
  pickDialog,
  promptText,
  useDialogStore,
} from "../stores/dialogStore";
import { useVaultStore } from "../stores/vaultStore";
import type { Strings } from "../lib/i18n";
import {
  createNoteFromTemplate,
  createStarterTemplates,
  templateFiles,
} from "../lib/templates";

/** Pick a template, prompt for a title, create and open. No-op without a vault. */
export async function newNoteFromTemplate(
  t: Strings,
  dir?: string,
): Promise<void> {
  if (!useVaultStore.getState().currentVault) return;
  const templatePath = await pickDialog({
    title: t.tpl_pick_title ?? "Choose a template",
    message: t.tpl_pick_msg,
    body: <TemplatePickerBody t={t} />,
  });
  if (!templatePath) return;
  const raw = await promptText({
    title: t.sb_new_note ?? "New note",
    message: t.sb_new_note_msg ?? "Note title (.md is added automatically)",
    placeholder: t.sb_new_note_ph ?? "untitled",
  });
  if (!raw) return;
  try {
    await createNoteFromTemplate(templatePath, raw, dir);
  } catch (e) {
    await confirmAction({
      title: t.sb_new_note ?? "New note",
      message: (
        t.tpl_note_error ?? "Could not create the note from the template: {err}"
      ).replace("{err}", String(e)),
    });
  }
}

function TemplatePickerBody({ t }: { t: Strings }): JSX.Element {
  const fileTree = useVaultStore((s) => s.fileTree);
  const close = useDialogStore((s) => s.close);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const templates = templateFiles(fileTree);

  async function createStarters(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await createStarterTemplates(t);
    } catch (e) {
      setErr(
        (t.tpl_create_error ?? "Could not create templates: {err}").replace(
          "{err}",
          String(e),
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  if (templates.length === 0) {
    return (
      <div>
        <p className="myco-modal__message">{t.tpl_empty}</p>
        {err ? (
          <p role="alert" className="muted">
            {err}
          </p>
        ) : null}
        <button
          type="button"
          className="myco-modal__btn myco-modal__btn--primary"
          disabled={busy}
          onClick={() => void createStarters()}
        >
          {busy
            ? (t.tpl_creating ?? "Creating…")
            : (t.tpl_create_starters ?? "Create templates folder")}
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: "0.35rem" }}>
      {templates.map((f, i) => (
        <button
          key={f.path}
          type="button"
          className="myco-modal__btn"
          // Refocus when the list replaces the empty state (the disabled
          // "Create" button dropped focus to <body>); a no-op on a fresh open.
          autoFocus={i === 0}
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => close(f.path)}
        >
          {f.name.replace(/\.md$/i, "")}
        </button>
      ))}
    </div>
  );
}
