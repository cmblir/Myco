// DialogHost renders the active prompt/confirm modal from dialogStore.
// Mount it once near the root of the app.

import { useEffect, useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { useDialogStore } from "../stores/dialogStore";
import { useUIStore } from "../stores/uiStore";
import { STRINGS } from "../lib/i18n";
import { isComposingKey } from "../lib/ime";

// Elements that can receive keyboard focus inside the dialog. Used to keep
// Tab / Shift+Tab cycling within the modal (a lightweight focus trap).
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function DialogHost(): JSX.Element | null {
  const request = useDialogStore((s) => s.request);
  const close = useDialogStore((s) => s.close);
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang] ?? STRINGS.en;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  // Element focused before the dialog opened, so we can restore on close.
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!request) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setValue(request.defaultValue ?? "");
    // Focus the text input for prompts, otherwise the primary action button.
    setTimeout(() => {
      if (request.kind === "prompt") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        primaryRef.current?.focus();
      }
    }, 0);
    // Restore focus to the previously-focused element when the dialog closes.
    return () => {
      previouslyFocused.current?.focus();
    };
  }, [request]);

  if (!request) return null;

  function cancel() {
    close(null);
  }

  function submit() {
    if (!request) return;
    if (request.kind === "prompt") {
      const trimmed = value.trim();
      close(trimmed.length > 0 ? trimmed : null);
    } else {
      close("ok");
    }
  }

  // Trap Tab / Shift+Tab within the dialog and route Escape to cancel.
  function onDialogKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  const primaryLabel =
    request.kind === "confirm"
      ? request.danger
        ? t.dlg_delete
        : t.dlg_ok
      : t.dlg_create;

  return (
    <div className="memex-modal__backdrop" onClick={cancel}>
      <div
        ref={dialogRef}
        className="memex-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={request.title ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <h2 id={titleId} className="memex-modal__title">
          {request.title}
        </h2>
        {request.message ? (
          <p className="memex-modal__message">{request.message}</p>
        ) : null}
        {request.kind === "prompt" ? (
          <input
            ref={inputRef}
            type="text"
            className="memex-modal__input"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === "Enter") submit();
            }}
          />
        ) : null}
        <div className="memex-modal__actions">
          <button type="button" className="memex-modal__btn" onClick={cancel}>
            {t.dlg_cancel}
          </button>
          <button
            ref={primaryRef}
            type="button"
            className={`memex-modal__btn memex-modal__btn--primary${
              request.danger ? " memex-modal__btn--danger" : ""
            }`}
            onClick={submit}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
