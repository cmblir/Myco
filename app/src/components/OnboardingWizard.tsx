// First-run onboarding wizard (UX-01; three steps since UX S18). An overlay
// shown only on a genuine first run (no vault / empty vault) and never again
// once completed or skipped — App persists a `myco.onboarded` flag, calls
// onClose, and keeps the wizard up while its note step makes the first page.
//
// Steps: choose a folder → write a first note (or bring in a file's text) →
// ask one question about it, which opens Ask on the answer. Session import
// and vault history used to be steps a new user met before writing anything;
// they wait on Home now (HomeGuide) and in Settings. Reuses the modal shell
// (.myco-modal*) so it stays visually consistent with DialogHost.

import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import MascotClip from "./MascotClip";
import { SURFACE_CLIPS } from "../lib/mascotClips";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReindexStore } from "../stores/reindexStore";
import { askCopy, useQueryStore } from "../stores/queryStore";
import {
  escapeSkips,
  firstNoteDraft,
  wizardPrimary,
  wizardStepReady,
  writeFirstNote,
  WIZARD_STEPS,
  type FirstNote,
} from "../lib/onboarding";
import { setQueryPrefill } from "../lib/queryPrefill";
import {
  createSourceLoader,
  sourceLoadMessage,
  type SourceLoader,
} from "../lib/sourceLoad";
import { isComposingKey } from "../lib/ime";
import { ipc } from "../lib/ipc";
import { focusInto, useModalFocus } from "./useModalFocus";

/** The step's own control: its text box, else its one primary button. */
function stepControl(dialog: HTMLElement | null): HTMLElement | null {
  return (
    dialog?.querySelector<HTMLElement>("[data-ob-focus]") ??
    dialog?.querySelector<HTMLElement>('.btn-primary:not([aria-disabled="true"])') ??
    null
  );
}

export default function OnboardingWizard({
  t,
  onClose,
}: {
  t: Strings;
  onClose: () => void;
}): JSX.Element {
  const [step, setStep] = useState(0);
  // Buttons stay focusable while an action runs (aria-disabled, never
  // disabled): a focused button that turns disabled drops focus to <body>,
  // where Tab and Escape no longer reach the wizard.
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileNeedsSettings, setFileNeedsSettings] = useState(false);
  const fileLoad = useRef<SourceLoader | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  /** A picked folder with no pages of its own — offer the demo notes. */
  const [emptyPick, setEmptyPick] = useState(false);
  const [text, setText] = useState("");
  /** The file whose text is in the box — it names the note. */
  const [fileName, setFileName] = useState<string | null>(null);
  /** The note step 1 wrote. */
  const [saved, setSaved] = useState<FirstNote | null>(null);
  /** The user's own edit of the question; null follows the saved note. */
  const [edited, setEdited] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const lang = useUIStore((s) => s.lang);
  const setRoute = useUIStore((s) => s.setRoute);
  const currentVault = useVaultStore((s) => s.currentVault);
  const vaultError = useVaultStore((s) => s.error);
  const openVault = useVaultStore((s) => s.openVault);
  const refreshTree = useVaultStore((s) => s.refreshTree);
  const stage = useReindexStore((s) => s.stage);
  const done = useReindexStore((s) => s.done);
  const total = useReindexStore((s) => s.total);
  const reindexError = useReindexStore((s) => s.error);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  function close(): void {
    fileLoad.current?.invalidate();
    onClose();
  }
  // The first screen a new user sees owns focus: it opens on the step's
  // primary button, Tab stays inside, and Escape is Skip, except over a
  // first note not saved yet. `shape` brings focus back in when the
  // demo-notes button it was on goes away.
  const { onKeyDown } = useModalFocus(dialogRef, {
    open: true,
    onEscape: () => {
      if (escapeSkips(step, text, saved?.text ?? null)) close();
    },
    initial: () => stepControl(dialogRef.current),
    shape: `${step}:${emptyPick}`,
  });

  useEffect(() => {
    const loader = createSourceLoader({
      onBusy: setFileBusy,
      onLoaded: (path, loaded) => {
        setText(loaded);
        setFileName(path.split(/[\\/]/).pop() ?? null);
      },
      onError: (error) => {
        setProblem(sourceLoadMessage(error, tRef.current));
        setFileNeedsSettings(
          error.code === "capability_unavailable" ||
            error.code === "authority_changed" ||
            error.code === "credential_unavailable",
        );
      },
    });
    fileLoad.current = loader;
    return () => {
      loader.dispose();
      if (fileLoad.current === loader) fileLoad.current = null;
    };
  }, []);

  // A new step's own control takes focus. Next and Back stay mounted across
  // steps, so focus would otherwise sit on them (or on <body>, once Back
  // turns disabled on the first step) instead of the box to type in.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    focusInto(dialogRef.current, () => stepControl(dialogRef.current));
  }, [step]);

  const question =
    edited ??
    (saved
      ? t.ob_first_question_note.replace("{title}", saved.title)
      : t.ob_first_question);

  function go(next: number): void {
    fileLoad.current?.invalidate();
    setProblem(null);
    setFileNeedsSettings(false);
    setStep(next);
  }

  async function linkVault(path: string): Promise<void> {
    await openVault(path);
    // openVault never rejects — it stores failures in `error` and only sets
    // `currentVault` on success. Advance only when the pick actually linked a
    // vault, so a failed open keeps the user on this step.
    const { currentVault: opened, error, fileTree } = useVaultStore.getState();
    if (!opened || error) return;
    setEmptyPick(fileTree.length === 0);
    go(1);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || fileBusy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  async function pickVault(): Promise<void> {
    if (busy || fileBusy) return;
    const path = await ipc.pickDirectory();
    if (path) await run(() => linkVault(path));
  }

  const startWithDemoVault = (): Promise<void> =>
    run(async () => linkVault(await ipc.ensureDefaultVault()));

  const seedPickedVault = (): Promise<void> =>
    run(async () => {
      if (!currentVault) return;
      await ipc.seedSampleVault(currentVault.path);
      await refreshTree();
      setEmptyPick(false);
    });

  async function loadFile(): Promise<void> {
    if (busy) return;
    setProblem(null);
    setFileNeedsSettings(false);
    await fileLoad.current?.load();
  }

  // Next on the note step writes the note (lib/onboarding writeFirstNote):
  // the first time it makes wiki/<title>.md, after Back it rewrites that
  // note, renamed when the first line changed.
  const saveNote = (): Promise<void> =>
    run(async () => {
      const draft = firstNoteDraft(text, fileName, t.ob_note_name);
      if (!draft || !currentVault || saved?.text === text) {
        go(2);
        return;
      }
      try {
        const note = await writeFirstNote(ipc, `${currentVault.path}/wiki`, draft, saved, text);
        await refreshTree();
        setSaved(note);
        setEdited(null);
        go(2);
      } catch (e) {
        // create_file says "already exists", a rename "destination exists".
        setProblem(
          /already exists|destination exists/.test(String(e))
            ? t.ob_note_exists
            : t.ob_note_failed.replace("{error}", String(e)),
        );
      }
    });

  // The question step builds the first index itself. autoReindex never does
  // (indexed_pages 0 ⇒ no auto), so without this a new user's Ask would have
  // nothing to read. A vault that already has an index takes the new note in
  // through the backend's live IndexUpdater.
  useEffect(() => {
    if (step !== 2 || !currentVault) return;
    const { stage: s, refreshStatus, reindex } = useReindexStore.getState();
    if (s === "loading-model" || s === "indexing") return;
    void refreshStatus().then(() => {
      if ((useReindexStore.getState().indexedPages ?? 0) === 0) void reindex();
    });
  }, [step, currentVault]);

  const indexing = stage === "loading-model" || stage === "indexing";
  const ready =
    !busy && !fileBusy && wizardStepReady(step, stage, Boolean(currentVault));

  // The ask runs in queryStore, so Ask opens on the turn already in flight
  // (HomeAsk's path); with another answer still running, the question waits
  // in Ask's field instead of vanishing.
  function ask(): void {
    const q = question.trim();
    if (!q || !ready) return;
    const query = useQueryStore.getState();
    if (query.busy) setQueryPrefill(q);
    else void query.ask(q, lang, askCopy(t));
    setRoute("query");
    close();
  }

  // The step's one filled button: its own action, or Next once that is done.
  const nextPrimary = wizardPrimary(step, Boolean(currentVault)) === "next";
  const actionCls = nextPrimary ? "btn" : "btn btn-primary";
  const isLast = step === WIZARD_STEPS - 1;

  return (
    <div
      ref={dialogRef}
      className="myco-modal__backdrop onboarding-backdrop"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <div className="myco-modal onboarding">
        <div className="ob-head">
          <span className="ob-eyebrow">{t.ob_title}</span>
          <span className="ob-head__end">
            <span className="ob-step">
              {t.ob_step.replace("{n}", String(step + 1)).replace("{total}", String(WIZARD_STEPS))}
            </span>
            <button type="button" className="ob-skip" onClick={close}>
              {t.ob_skip}
            </button>
          </span>
        </div>

        <div className="ob-body">
          {step !== 1 ? (
            <div className="ob-icon ob-icon--mascot">
              {/* Step 1 greets once, then holds the attention pose. */}
              {step === 0 ? (
                <MascotClip {...SURFACE_CLIPS.wizard} />
              ) : (
                <MascotClip clip="idle" size={72} />
              )}
            </div>
          ) : null}

          {step === 0 ? (
            <>
              <h2 id={titleId} className="ob-step-title">
                {t.ob_s1_title}
              </h2>
              {/* The local-first promise, said once, where the user decides
                  to trust myco with a folder. */}
              <p className="ob-step-body">{t.ob_s1_body}</p>
              <div className="ob-row">
                <button
                  type="button"
                  className={actionCls}
                  onClick={() => void pickVault()}
                  aria-disabled={busy}
                  aria-busy={busy}
                >
                  {t.ob_s1_action}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn"
                  onClick={() => void startWithDemoVault()}
                  aria-disabled={busy}
                >
                  {t.ob_demo_start}
                </button>
              </div>
              <p className="ob-vault-note">
                {currentVault ? `${t.ob_vault_linked}: ${currentVault.name}` : t.ob_vault_none}
              </p>
              {vaultError ? (
                <p className="ob-vault-note" role="alert">
                  {vaultError}
                </p>
              ) : null}
            </>
          ) : null}

          {step === 1 ? (
            <>
              <h2 id={titleId} className="ob-step-title">
                {t.ob_note_title}
              </h2>
              <p className="ob-step-body">{t.ob_note_body}</p>
              <textarea
                data-ob-focus
                className="textarea ob-note"
                rows={5}
                value={text}
                placeholder={t.ob_note_ph}
                aria-label={t.ob_note_name}
                onChange={(e) => {
                  fileLoad.current?.invalidate();
                  setText(e.target.value);
                  if (!e.target.value.trim()) setFileName(null);
                }}
              />
              <div className="ob-row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void loadFile()}
                  aria-disabled={busy}
                  aria-busy={fileBusy}
                >
                  {t.ob_note_file}
                </button>
                {emptyPick ? (
                  <button
                    type="button"
                    className="btn-ghost btn"
                    onClick={() => void seedPickedVault()}
                    aria-disabled={busy}
                  >
                    {t.ob_seed_do}
                  </button>
                ) : null}
              </div>
              {problem ? (
                <p className="ob-vault-note" role="alert">
                  {problem}
                  {fileNeedsSettings ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        useUIStore.getState().setSettingsTab("model");
                        setRoute("settings");
                        close();
                      }}
                    >
                      {t.q_open_model_settings}
                    </button>
                  ) : null}
                </p>
              ) : (
                <p className="ob-vault-note" role="status">
                  {fileBusy
                    ? t.st_loading
                    : fileName
                      ? t.ob_note_loaded.replace("{name}", fileName)
                      : t.ob_note_skip_hint}
                </p>
              )}
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h2 id={titleId} className="ob-step-title">
                {t.ob_s3_title}
              </h2>
              <p className="ob-step-body">{t.ob_s3_body}</p>
              <input
                data-ob-focus
                className="input ob-question"
                value={question}
                aria-label={t.ob_ask_label}
                onChange={(e) => setEdited(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || isComposingKey(e)) return;
                  e.preventDefault();
                  ask();
                }}
              />
              <button
                type="button"
                className={actionCls}
                style={{ marginTop: 12 }}
                onClick={ask}
                aria-disabled={!ready || !question.trim()}
              >
                {t.ob_ask_now}
              </button>
              {indexing ? (
                <p className="ob-vault-note" role="status">
                  {t.ob_index_title}
                  {total > 0
                    ? ` ${t.ob_index_progress.replace("{done}", String(done)).replace("{total}", String(total))}`
                    : ""}
                </p>
              ) : null}
              {stage === "error" ? (
                <p className="ob-vault-note" role="alert">
                  {t.ob_index_failed}
                  {reindexError ? `: ${reindexError}` : ""}
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="ob-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => go(step - 1)}
            disabled={step === 0}
          >
            {t.ob_back}
          </button>
          {isLast ? (
            <button type="button" className="btn" onClick={close}>
              {t.ob_finish}
            </button>
          ) : (
            // aria-disabled, not disabled: a focused button that turns disabled
            // is blurred (Enter then hit Skip in Chromium; in WebKit focus fell
            // to <body>, out of reach of Escape). Focus stays here instead.
            <button
              type="button"
              className={nextPrimary ? "btn btn-primary" : "btn"}
              onClick={() => {
                if (!ready) return;
                if (step === 1) void saveNote();
                else go(step + 1);
              }}
              aria-disabled={!ready}
            >
              {t.ob_next}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
