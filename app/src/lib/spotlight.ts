// The global-shortcut spotlight's wiring, both halves.
//
// The spotlight is a SEPARATE webview (Rust opens index.html?window=spotlight),
// so it has no vault open and no queryStore of its own. It therefore does not
// answer anything: it emits the question, and the MAIN window — the one that
// already has the vault, the settings and the retrieval state — runs the exact
// same `useQueryStore.ask` the Ask page runs and emits the finished turn back.
// One ask path, as with tray actions; a second answer path in the second
// webview would be a second set of bugs.
//
// The two windows talk over the Tauri event bus (`core:event:default` grants
// emit + listen; verified in the tauri 2.11.1 ACL), so no relay command is
// needed for the question itself.

import { STRINGS } from "./i18n";
import { askCopy, useQueryStore } from "../stores/queryStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { wikilinkBase } from "./wikilinks";

/** Spotlight → main window: the question, verbatim. */
export const SPOTLIGHT_ASK_EVENT = "myco://spotlight-ask";
/** Main window → spotlight: the finished turn. */
export const SPOTLIGHT_ANSWER_EVENT = "myco://spotlight-answer";
/** Spotlight → main window: a citation was clicked; open the app on it. */
export const SPOTLIGHT_OPEN_EVENT = "myco://spotlight-open";
/** Rust → spotlight: the window was just shown; reset and focus the input. */
export const SPOTLIGHT_OPENED_EVENT = "myco://spotlight-opened";

/** The answered turn, as the spotlight renders it. Mirrors the fields of
 *  ChatTurn the spotlight actually shows — it has no store to read. */
export interface SpotlightAnswer {
  question: string;
  /** Markdown, with [[stem]] citations the spotlight renders as links. */
  answer: string;
  /** Why there is no answer: a provider/IPC failure, no vault open, or the
   *  main window being busy with another question. Shown instead of `answer`. */
  error?: string;
  /** Quoted passages rather than model synthesis (builtin-local provider). */
  extractive?: boolean;
}

/** Wire the main window's half: answer the spotlight's questions and follow
 *  its citation clicks. Call ONCE, from the main window only. Returns a
 *  teardown. Safe in a plain browser (no event bus): it just does nothing. */
export function initSpotlightBridge(): () => void {
  const unlisteners: (() => void)[] = [];
  let cancelled = false;

  const subscribe = <T,>(
    event: string,
    handler: (payload: T) => void,
  ): void => {
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<T>(event, (e) => handler(e.payload)))
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
  };

  const reply = (payload: SpotlightAnswer): void => {
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit(SPOTLIGHT_ANSWER_EVENT, payload))
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
  };

  subscribe<string>(SPOTLIGHT_ASK_EVENT, (raw) => {
    const question = (raw ?? "").trim();
    if (!question) return;
    const { lang } = useUIStore.getState();
    const t = STRINGS[lang];
    if (!useVaultStore.getState().currentVault) {
      reply({
        question,
        answer: "",
        error: t.spot_no_vault ?? "Open a vault in myco first.",
      });
      return;
    }
    if (useQueryStore.getState().busy) {
      // ask() would return early and the last turn would be the OTHER
      // question's — say so instead of answering the wrong thing.
      reply({
        question,
        answer: "",
        error: t.spot_busy ?? "myco is still answering the previous question.",
      });
      return;
    }
    void useQueryStore
      .getState()
      .ask(question, lang, askCopy(t))
      .then(() => {
        const turn = useQueryStore.getState().turns.at(-1);
        reply({
          question,
          answer: turn?.a ?? "",
          error: turn?.error,
          extractive: turn?.extractive,
        });
      });
  });

  subscribe<string>(SPOTLIGHT_OPEN_EVENT, (target) => {
    const base = target ? wikilinkBase(target) : "";
    if (!base) return;
    // Same resolve-or-create behaviour a wikilink click has anywhere else.
    void useVaultStore
      .getState()
      .openWikilink(base)
      .then((path) => {
        if (path) useUIStore.getState().setRoute(`page:${path}`);
      });
  });

  return () => {
    cancelled = true;
    for (const u of unlisteners) u();
    unlisteners.length = 0;
  };
}
