// Custom prompt/confirm dialogs. Tauri's WKWebView silently swallows
// window.prompt and window.confirm, so we render React modals and resolve
// promises imperatively from anywhere in the app.

import { create } from "zustand";
import type { ReactNode } from "react";

export type DialogKind = "prompt" | "confirm" | "pick";

export interface DialogRequest {
  kind: DialogKind;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  danger?: boolean;
  /** Primary button text; defaults by kind (Create / OK / Delete). */
  confirmLabel?: string;
  /** Rendered between message and actions (e.g. a diff preview), scrollable. */
  body?: ReactNode;
  resolve: (value: string | null) => void;
}

interface DialogState {
  request: DialogRequest | null;
  open: (req: DialogRequest) => void;
  close: (value: string | null) => void;
}

export const useDialogStore = create<DialogState>((set, get) => ({
  request: null,
  open: (req) => set({ request: req }),
  close: (value) => {
    const req = get().request;
    if (!req) return;
    req.resolve(value);
    set({ request: null });
  },
}));

export function promptText(opts: {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({
      kind: "prompt",
      title: opts.title,
      message: opts.message,
      defaultValue: opts.defaultValue,
      placeholder: opts.placeholder,
      confirmLabel: opts.confirmLabel,
      resolve,
    });
  });
}

export function confirmAction(opts: {
  title: string;
  message: string;
  danger?: boolean;
  body?: ReactNode;
  confirmLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({
      kind: "confirm",
      title: opts.title,
      message: opts.message,
      danger: opts.danger,
      body: opts.body,
      confirmLabel: opts.confirmLabel,
      resolve: (v) => resolve(v === "ok"),
    });
  });
}

/** List-style dialog: `body` renders the choices and calls
 *  useDialogStore.getState().close(value) itself; no primary button. */
export function pickDialog(opts: {
  title: string;
  message?: string;
  body: ReactNode;
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({ kind: "pick", ...opts, resolve });
  });
}
