// First-run onboarding wizard (UX-01, reshaped for M10; import-first reshape
// per the 2026-08 research: churn lands on days 4–12 while accrued-value AI
// pays off after day 30 — the only structural fix is to import the user's
// existing history up front so the first Ask answers from THEIR data). A
// 5-step overlay shown only on a genuine first run (no vault / empty vault)
// and never again once completed or skipped — App persists a `myco.onboarded`
// flag and calls onClose.
//
// Steps: pick a folder → import sessions (free: they index locally, no
// provider needed) → watch it index → offer git history (Q4 decision 1's
// onboarding half) → ask the first question against what just came in.
// Reuses the modal shell (.myco-modal*) so it stays visually consistent with
// DialogHost instead of inventing a parallel design system.

import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import MascotClip from "./MascotClip";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReindexStore } from "../stores/reindexStore";
import { useImportStore } from "../stores/importStore";
import { useSettingsStore } from "../stores/settingsStore";
import { wizardStepReady, WIZARD_STEPS } from "../lib/onboarding";
import { setQueryPrefill } from "../lib/queryPrefill";
import { ipc, type VaultHistoryStatus } from "../lib/ipc";

export default function OnboardingWizard({
  t,
  onClose,
}: {
  t: Strings;
  onClose: () => void;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  /** A picked folder with no pages of its own — offer the demo notes. */
  const [emptyPick, setEmptyPick] = useState(false);
  const setRoute = useUIStore((s) => s.setRoute);
  const currentVault = useVaultStore((s) => s.currentVault);
  const openVault = useVaultStore((s) => s.openVault);
  const refreshTree = useVaultStore((s) => s.refreshTree);
  const stage = useReindexStore((s) => s.stage);
  const done = useReindexStore((s) => s.done);
  const total = useReindexStore((s) => s.total);
  const indexedPages = useReindexStore((s) => s.indexedPages);
  const reindexError = useReindexStore((s) => s.error);
  const importStage = useImportStore((s) => s.stage);
  const impDone = useImportStore((s) => s.done);
  const impTotal = useImportStore((s) => s.total);
  const impImported = useImportStore((s) => s.imported);
  const impQuarantined = useImportStore((s) => s.quarantined);
  const impError = useImportStore((s) => s.error);
  const sweep = useImportStore((s) => s.sweep);
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const [histStatus, setHistStatus] = useState<VaultHistoryStatus | null>(null);
  const titleId = useId();

  // The first question follows what onboarding actually brought in: a sweep
  // that imported sessions makes a time question answerable on day zero; an
  // untouched vault keeps the generic topics question.
  const question =
    impImported > 0
      ? (t.ob_first_question_sessions ?? "What did I work on last week?")
      : (t.ob_first_question ?? "What topics do these notes cover most?");

  async function linkVault(path: string): Promise<void> {
    await openVault(path);
    // openVault never rejects — it stores failures in `error` and only sets
    // `currentVault` on success. Advance only when the pick actually linked a
    // vault, so a failed open keeps the user on this step.
    const { currentVault: opened, error, fileTree } = useVaultStore.getState();
    if (!opened || error) return;
    setEmptyPick(fileTree.length === 0);
    setStep(1);
  }

  async function pickVault(): Promise<void> {
    const path = await ipc.pickDirectory();
    if (!path) return;
    setBusy(true);
    try {
      await linkVault(path);
    } finally {
      setBusy(false);
    }
  }

  async function startWithDemoVault(): Promise<void> {
    setBusy(true);
    try {
      const path = await ipc.ensureDefaultVault();
      await linkVault(path);
    } finally {
      setBusy(false);
    }
  }

  async function seedPickedVault(): Promise<void> {
    if (!currentVault) return;
    setBusy(true);
    try {
      await ipc.seedSampleVault(currentVault.path);
      await refreshTree();
      setEmptyPick(false);
    } finally {
      setBusy(false);
    }
  }

  // The index step builds the first index itself. autoReindex deliberately
  // never does (indexed_pages 0 ⇒ no auto), so without this the wizard would
  // hand over an app whose Ask has nothing to read. Runs AFTER the import
  // step so the build covers whatever the sweep brought in.
  useEffect(() => {
    if (step !== 2 || !currentVault) return;
    const { stage: s, refreshStatus, reindex } = useReindexStore.getState();
    if (s === "loading-model" || s === "indexing" || s === "done") return;
    void refreshStatus().then(() => {
      if ((useReindexStore.getState().indexedPages ?? 0) === 0) void reindex();
    });
  }, [step, currentVault]);

  // History step: whether this vault already has git (then the offer is moot).
  useEffect(() => {
    if (step !== 3 || !currentVault) return;
    let cancelled = false;
    ipc
      .vaultHistoryStatus(currentVault.path)
      .then((s) => {
        if (!cancelled) setHistStatus(s);
      })
      .catch(() => {
        if (!cancelled) setHistStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [step, currentVault]);

  async function enableHistory(): Promise<void> {
    if (!currentVault || busy) return;
    setBusy(true);
    try {
      await ipc.initVaultHistory(currentVault.path);
      await loadSettings();
      setHistStatus({ git_present: true, enabled: true });
    } finally {
      setBusy(false);
    }
  }

  const historyOn = Boolean(settings?.vault_history_enabled) || Boolean(histStatus?.git_present);

  const ready = wizardStepReady(step, stage, Boolean(currentVault), importStage);
  const isLast = step === WIZARD_STEPS - 1;
  const isFirst = step === 0;

  return (
    <div
      className="myco-modal__backdrop onboarding-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="myco-modal onboarding">
        <div className="ob-head">
          <span className="ob-eyebrow">{t.ob_title ?? "Welcome to myco"}</span>
          <button type="button" className="ob-skip" onClick={onClose}>
            {t.ob_skip ?? "Skip"}
          </button>
        </div>

        <div className="ob-dots" aria-hidden="true">
          {Array.from({ length: WIZARD_STEPS }, (_, i) => (
            <span key={i} className={"ob-dot" + (i === step ? " active" : "")} />
          ))}
        </div>

        <div className="ob-body">
          {step === 0 ? (
            <>
              <div className="ob-icon ob-icon--mascot">
                <MascotClip clip="idle" size={72} />
              </div>
              <h2 id={titleId} className="ob-step-title">
                {t.ob_s1_title ?? "Point myco at a folder"}
              </h2>
              <p className="ob-step-body">
                {t.ob_s1_body ??
                  "An Obsidian vault, a markdown folder, anything. Every page stays plain markdown you own."}
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void pickVault()}
                disabled={busy}
                aria-busy={busy}
              >
                {t.ob_s1_action ?? "Choose a folder…"}
              </button>
              <button
                type="button"
                className="btn-ghost btn"
                style={{ marginTop: 8 }}
                onClick={() => void startWithDemoVault()}
                disabled={busy}
              >
                {t.ob_demo_start ?? "Start with a demo vault"}
              </button>
              <p className="ob-vault-note">
                {currentVault
                  ? `${t.ob_vault_linked ?? "Linked"}: ${currentVault.name}`
                  : (t.ob_vault_none ?? "No vault linked yet")}
              </p>
              {/* The file-sovereignty promise, stated where the user decides to
                  trust myco with a folder. This is the app-side half of the
                  README's "built to outlive its vendor" block. */}
              <p className="ob-vault-note">
                {t.ob_sovereignty ??
                  "Plain markdown · raw/ is never modified · shares a folder with Obsidian — delete myco and keep everything."}
              </p>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="ob-icon ob-icon--mascot">
                <MascotClip clip="idle" size={72} />
              </div>
              <h2 id={titleId} className="ob-step-title">
                {t.ob_imp_title ?? "Bring your history"}
              </h2>
              <p className="ob-step-body">
                {t.ob_imp_body ??
                  "myco can import your Claude Code and Codex sessions. They index on this device only — searching and asking about them is free."}
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void sweep("claude-code")}
                  disabled={importStage === "sweeping" || importStage === "importing-file"}
                >
                  {t.ob_imp_claude ?? "Import Claude Code sessions"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void sweep("codex")}
                  disabled={importStage === "sweeping" || importStage === "importing-file"}
                >
                  {t.ob_imp_codex ?? "Import Codex sessions"}
                </button>
              </div>
              {importStage === "sweeping" ? (
                <>
                  <div
                    className="cov-bar"
                    style={{ maxWidth: 220, margin: "12px auto 0" }}
                    role="progressbar"
                    aria-valuenow={impTotal > 0 ? Math.round((impDone / impTotal) * 100) : 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span
                      className="cov-bar-fill"
                      style={{
                        width: impTotal > 0 ? `${Math.round((impDone / impTotal) * 100)}%` : "8%",
                      }}
                    />
                  </div>
                  <p className="ob-vault-note">
                    {(t.ob_imp_progress ?? "{done} of {total} files")
                      .replace("{done}", String(impDone))
                      .replace("{total}", String(impTotal))}
                  </p>
                </>
              ) : null}
              {importStage === "done" ? (
                <p className="ob-vault-note">
                  {(t.ob_imp_done ?? "{n} sessions imported").replace(
                    "{n}",
                    String(impImported),
                  )}
                  {/* Held-back items must be visible or "imported then vanished"
                      is the read — the quarantine is a feature, not a loss. */}
                  {impQuarantined.length > 0
                    ? " · " +
                      (t.ob_imp_quarantined ?? "{n} held back (possible secrets)").replace(
                        "{n}",
                        String(impQuarantined.length),
                      )
                    : ""}
                </p>
              ) : null}
              {importStage === "error" ? (
                <p className="ob-vault-note">{impError ?? ""}</p>
              ) : null}
              <p className="ob-vault-note">
                {t.ob_imp_skip_hint ?? "Nothing to import? Just continue."}
              </p>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="ob-icon ob-icon--mascot">
                <MascotClip clip="idle" size={72} />
              </div>
              <h2 id={titleId} className="ob-step-title">
                {stage === "error"
                  ? (t.ob_s2_failed ?? "Indexing didn't finish")
                  : (t.ob_s2_title ?? "Reading your notes")}
              </h2>
              <p className="ob-step-body">
                {stage === "error"
                  ? (reindexError ?? "")
                  : total > 0
                    ? (t.ob_s2_progress ?? "{done} of {total} notes")
                        .replace("{done}", String(done))
                        .replace("{total}", String(total))
                    : (t.ob_s2_body ?? "Building the index…")}
              </p>
              <div
                className="cov-bar"
                style={{ maxWidth: 220, margin: "12px auto 0" }}
                role="progressbar"
                aria-valuenow={total > 0 ? Math.round((done / total) * 100) : 0}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span
                  className="cov-bar-fill"
                  style={{
                    width:
                      stage === "done"
                        ? "100%"
                        : total > 0
                          ? `${Math.round((done / total) * 100)}%`
                          : "8%",
                  }}
                />
              </div>
              <p className="ob-vault-note">
                {t.ob_indexing_local ?? "The index is built on this device only."}
              </p>
              {emptyPick ? (
                <>
                  <p className="ob-step-body" style={{ marginTop: 10 }}>
                    {t.ob_seed_offer ??
                      "That folder is empty. Want a few demo notes to try things on?"}
                  </p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void seedPickedVault()}
                    disabled={busy}
                  >
                    {t.ob_seed_do ?? "Add demo notes"}
                  </button>
                </>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div className="ob-icon ob-icon--mascot">
                <MascotClip clip="idle" size={72} />
              </div>
              <h2 id={titleId} className="ob-step-title">
                {t.ob_hist_title ?? "Keep a history?"}
              </h2>
              <p className="ob-step-body">
                {t.vh_banner_desc ??
                  "Turn it on to see agent changes word by word and undo them."}
              </p>
              {historyOn ? (
                <p className="ob-vault-note">
                  {t.ob_hist_already ?? "History is already on for this vault."}
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void enableHistory()}
                    disabled={busy}
                    aria-busy={busy}
                  >
                    {t.vh_enable ?? "Turn on history"}
                  </button>
                  {/* Never a silent git init (Q4 decision 1) — declining is one
                      Next away and the Overview banner re-offers later. */}
                  <p className="ob-vault-note">
                    {t.ob_hist_skip_hint ?? "You can turn this on later from Overview."}
                  </p>
                </>
              )}
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="ob-icon ob-icon--mascot">
                <MascotClip clip="idle" size={72} />
              </div>
              <h2 id={titleId} className="ob-step-title">
                {t.ob_s3_title ?? "Ask your first question"}
              </h2>
              <p className="ob-step-body">
                {t.ob_s3_body ??
                  "Answers come from your own notes, with a citation on every claim."}
              </p>
              <div
                className="card-flat"
                style={{ margin: "10px auto 0", maxWidth: 340, textAlign: "left", fontSize: 13.5 }}
              >
                {question}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                onClick={() => {
                  setQueryPrefill(question);
                  setRoute("query");
                  onClose();
                }}
              >
                {t.ob_ask_now ?? "Ask it"}
              </button>
            </>
          ) : null}

          {indexedPages !== null && step === 2 && stage === "done" ? (
            <p className="ob-vault-note">
              {(t.ob_s2_indexed ?? "{n} notes indexed").replace(
                "{n}",
                String(indexedPages),
              )}
            </p>
          ) : null}
        </div>

        <div className="ob-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setStep((s) => s - 1)}
            disabled={isFirst}
          >
            {t.ob_back ?? "Back"}
          </button>
          {isLast ? (
            <button type="button" className="btn" onClick={onClose}>
              {t.ob_finish ?? "Done"}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => setStep((s) => s + 1)}
              disabled={!ready}
            >
              {t.ob_next ?? "Next"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
