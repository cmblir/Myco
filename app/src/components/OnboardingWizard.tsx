// First-run onboarding wizard (UX-01). A 3-step overlay shown only on a
// genuine first run (no vault / empty vault) and never again once completed or
// skipped — App persists a `memex.onboarded` flag and calls onClose here.
// Reuses the modal shell (.memex-modal*) so it stays visually consistent with
// DialogHost instead of inventing a parallel design system.

import { useId, useState } from "react";
import type { JSX } from "react";
import MascotClip from "./MascotClip";
import type { IconName } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { ipc } from "../lib/ipc";

interface Step {
  icon: IconName;
  title: string;
  body: string;
  action: string;
  run: () => void;
}

export default function OnboardingWizard({
  t,
  onClose,
}: {
  t: Strings;
  onClose: () => void;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const setRoute = useUIStore((s) => s.setRoute);
  const currentVault = useVaultStore((s) => s.currentVault);
  const openVault = useVaultStore((s) => s.openVault);
  const titleId = useId();

  async function pickVault(): Promise<void> {
    const path = await ipc.pickDirectory();
    if (!path) return;
    await openVault(path);
    // openVault never rejects — it stores failures in `error` and only sets
    // `currentVault` on success. Advance to step 2 only when the pick actually
    // linked a vault, so a failed open keeps the user on this step. setStep(1)
    // (not s + 1) because this action belongs to step 1 and the async resolve
    // must not double-advance if the user already clicked Next meanwhile.
    const { currentVault: opened, error } = useVaultStore.getState();
    if (opened && !error) setStep(1);
  }

  const steps: Step[] = [
    {
      icon: "folder",
      title: t.ob_s1_title ?? "Create or open a project",
      body:
        t.ob_s1_body ??
        "Memex keeps every page as plain markdown in a folder you control. Open an existing folder, or keep the default vault Memex just created for you.",
      action: t.ob_s1_action ?? "Open a folder…",
      run: () => void pickVault(),
    },
    {
      icon: "upload",
      title: t.ob_s2_title ?? "Add your first source",
      body:
        t.ob_s2_body ??
        "Drop a file, paste a URL, or write a note. Memex reads it, extracts entities and concepts, and weaves a cited page into your graph.",
      action: t.ob_s2_action ?? "Go to Ingest",
      run: () => {
        setRoute("ingest");
        onClose();
      },
    },
    {
      icon: "msg",
      title: t.ob_s3_title ?? "Ask a question",
      body:
        t.ob_s3_body ??
        "Ask the wiki anything. Memex answers from your pages first and reaches into raw sources only when needed — every claim ships with a citation.",
      action: t.ob_s3_action ?? "Go to Ask",
      run: () => {
        setRoute("query");
        onClose();
      },
    },
  ];

  const cur = steps[step];
  const isLast = step === steps.length - 1;
  const isFirst = step === 0;

  return (
    <div
      className="memex-modal__backdrop onboarding-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="memex-modal onboarding">
        <div className="ob-head">
          <span className="ob-eyebrow">{t.ob_title ?? "Welcome to Memex"}</span>
          <button type="button" className="ob-skip" onClick={onClose}>
            {t.ob_skip ?? "Skip"}
          </button>
        </div>

        <div className="ob-dots" aria-hidden="true">
          {steps.map((_, i) => (
            <span
              key={i}
              className={"ob-dot" + (i === step ? " active" : "")}
            />
          ))}
        </div>

        <div className="ob-body">
          <div className="ob-icon ob-icon--mascot">
            <MascotClip clip="idle" size={72} />
          </div>
          <h2 id={titleId} className="ob-step-title">
            {cur.title}
          </h2>
          <p className="ob-step-body">{cur.body}</p>
          <button type="button" className="btn btn-primary" onClick={cur.run}>
            {cur.action}
          </button>
          {isFirst ? (
            <p className="ob-vault-note">
              {currentVault
                ? `${t.ob_vault_linked ?? "Linked"}: ${currentVault.name}`
                : (t.ob_vault_none ?? "No vault linked yet")}
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
            >
              {t.ob_next ?? "Next"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
