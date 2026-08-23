// First-run onboarding wizard (UX-01, reshaped for M10). A 3-step overlay shown
// only on a genuine first run (no vault / empty vault) and never again once
// completed or skipped — App persists a `myco.onboarded` flag and calls onClose.
//
// The three steps are the sixty seconds from launch to a cited answer: pick a
// folder, watch it index, ask the first question. No structure decision, no tag
// scheme, no settings trip — the blank-vault setup tax is the thing this is
// built to avoid. Reuses the modal shell (.myco-modal*) so it stays visually
// consistent with DialogHost instead of inventing a parallel design system.

import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import MascotClip from "./MascotClip";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReindexStore } from "../stores/reindexStore";
import { wizardStepReady } from "../lib/onboarding";
import { setQueryPrefill } from "../lib/queryPrefill";
import { ipc } from "../lib/ipc";

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
  const titleId = useId();

  const question = t.ob_first_question ?? "What topics do these notes cover most?";

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

  // Step 2 builds the first index itself. autoReindex deliberately never does
  // (indexed_pages 0 ⇒ no auto), so without this the wizard would hand over an
  // app whose Ask has nothing to read.
  useEffect(() => {
    if (step !== 1 || !currentVault) return;
    const { stage: s, refreshStatus, reindex } = useReindexStore.getState();
    if (s === "loading-model" || s === "indexing" || s === "done") return;
    void refreshStatus().then(() => {
      if ((useReindexStore.getState().indexedPages ?? 0) === 0) void reindex();
    });
  }, [step, currentVault]);

  const ready = wizardStepReady(step, stage, Boolean(currentVault));
  const isLast = step === 2;
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
          {[0, 1, 2].map((i) => (
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
            </>
          ) : null}

          {step === 1 ? (
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

          {step === 2 ? (
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

          {indexedPages !== null && step === 1 && stage === "done" ? (
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
