// Custom prompt/confirm dialogs. Tauri's WKWebView silently swallows
// window.prompt and window.confirm, so we render React modals and resolve
// promises imperatively from anywhere in the app.

import { create } from "zustand";

export type DialogKind = "prompt" | "confirm";

interface DialogRequest {
  kind: DialogKind;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  danger?: boolean;
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
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({
      kind: "prompt",
      title: opts.title,
      message: opts.message,
      defaultValue: opts.defaultValue,
      placeholder: opts.placeholder,
      resolve,
    });
  });
}

export function confirmAction(opts: {
  title: string;
  message: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({
      kind: "confirm",
      title: opts.title,
      message: opts.message,
      danger: opts.danger,
      resolve: (v) => resolve(v === "ok"),
    });
  });
}
