// DialogHost renders the active prompt/confirm modal from dialogStore.
// Mount it once near the root of the app.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useDialogStore } from "../stores/dialogStore";
import type { DialogRequest } from "../stores/dialogStore";
import { useUIStore } from "../stores/uiStore";
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { isComposingKey } from "../lib/ime";
import { useModalFocus } from "./useModalFocus";

/** Where focus lands on open. A destructive confirm starts on Cancel: Enter
 *  right after the click that opened it must not be the thing that destroys. */
export function initialFocus(
  req: Pick<DialogRequest, "kind" | "danger">,
): "input" | "cancel" | "primary" {
  if (req.kind === "prompt") return "input";
  return req.kind === "confirm" && req.danger ? "cancel" : "primary";
}

export function primaryLabel(
  req: Pick<DialogRequest, "kind" | "danger" | "confirmLabel">,
  t: Strings,
): string {
  if (req.confirmLabel) return req.confirmLabel;
  if (req.kind !== "confirm") return t.dlg_create;
  return req.danger ? t.dlg_delete : t.dlg_ok;
}

/** Close with `value`, focus already back on the opener: the caller's code
 *  after the await runs next and may disable or unmount that opener (History's
 *  undo, Delete board). Restored only after that, focus falls to <body>. */
export function settleDialog(
  opener: { focus(): void } | null,
  close: (value: string | null) => void,
  value: string | null,
): void {
  opener?.focus();
  close(value);
}

export default function DialogHost(): JSX.Element | null {
  const request = useDialogStore((s) => s.request);
  const close = useDialogStore((s) => s.close);
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang] ?? STRINGS.en;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  function cancel() {
    settleDialog(opener.current, close, null);
  }

  function submit() {
    if (!request) return;
    if (request.kind === "prompt") {
      const trimmed = value.trim();
      settleDialog(opener.current, close, trimmed.length > 0 ? trimmed : null);
    } else {
      settleDialog(opener.current, close, "ok");
    }
  }

  // A prompt's input, Cancel for a danger confirm, else the primary button —
  // or, when there is none (pick), the first focusable element in the body.
  const target = request ? initialFocus(request) : null;
  const { onKeyDown, opener } = useModalFocus(dialogRef, {
    open: request,
    onEscape: cancel,
    initial: () =>
      target === "input"
        ? inputRef.current
        : target === "cancel"
          ? cancelRef.current
          : primaryRef.current,
  });

  // A dialog opened from the phone drawer (New note, Rename…) would sit in
  // front of a drawer still open behind it: the drawer closes (UX S49).
  useEffect(() => {
    if (!request || !window.matchMedia("(max-width: 768px)").matches) return;
    const ui = useUIStore.getState();
    if (!ui.sidebarCollapsed) ui.setSidebarCollapsed(true);
  }, [request]);

  useLayoutEffect(() => {
    if (!request) return;
    setValue(request.defaultValue ?? "");
    if (initialFocus(request) !== "input") return;
    // Once the default value has rendered: select it for replacing — unless
    // typing has already changed it, which selecting would swallow.
    const id = setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      if (document.activeElement !== input) input.focus();
      if (input.value === (request.defaultValue ?? "")) input.select();
    }, 0);
    return () => clearTimeout(id);
  }, [request]);

  if (!request) return null;

  return (
    <div
      className={`myco-modal__backdrop${request.kind === "pick" ? " myco-modal__backdrop--pick" : ""}`}
      onClick={cancel}
    >
      <div
        ref={dialogRef}
        className="myco-modal"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={request.title ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="myco-modal__title">
          {request.title}
        </h2>
        {request.message ? (
          <p className="myco-modal__message">{request.message}</p>
        ) : null}
        {request.body ? (
          <div style={{ maxHeight: 320, overflowY: "auto" }}>{request.body}</div>
        ) : null}
        {request.kind === "prompt" ? (
          <input
            ref={inputRef}
            type="text"
            className="myco-modal__input"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === "Enter") {
                // preventDefault, or the keydown's default action ("click the
                // focused element") lands on the opener button AFTER close()
                // restores focus to it — instantly reopening the dialog.
                e.preventDefault();
                submit();
              }
            }}
          />
        ) : null}
        <div className="myco-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="myco-modal__btn"
            onClick={cancel}
          >
            {t.dlg_cancel}
          </button>
          {request.kind !== "pick" ? (
            <button
              ref={primaryRef}
              type="button"
              className={`myco-modal__btn myco-modal__btn--primary${
                request.danger ? " myco-modal__btn--danger" : ""
              }`}
              onClick={submit}
            >
              {primaryLabel(request, t)}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
