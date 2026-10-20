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

import { openCaptured, openInboxDoc, type Captured } from "./dailyNote";
import { STRINGS } from "./i18n";
import { groupByPage } from "./extractive";
import { askCopy, QUOTED_PAGES, useQueryStore, type ChatTurn } from "../stores/queryStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { wikilinkBase } from "./wikilinks";

/** Spotlight → main window: the question, verbatim. */
export const SPOTLIGHT_ASK_EVENT = "myco://spotlight-ask";
/** Main window → spotlight: the finished turn. */
export const SPOTLIGHT_ANSWER_EVENT = "myco://spotlight-answer";
/** Spotlight → main window: a citation was clicked; open the app on it. */
export const SPOTLIGHT_OPEN_EVENT = "myco://spotlight-open";
/** Spotlight → main window: an abstention's "Open in Ask" — show the Ask
 *  page, where the turn and its near misses already are. Not a sentinel on
 *  SPOTLIGHT_OPEN_EVENT: that path resolves-or-creates a page. */
export const SPOTLIGHT_OPEN_ASK_EVENT = "myco://spotlight-open-ask";
/** Spotlight → main window: the abstention's written question was opened —
 *  show the daily note capture_note named, on the line it wrote (Captured). */
export const SPOTLIGHT_OPEN_DAILY_EVENT = "myco://spotlight-open-daily";
/** Spotlight → main window: the voice receipt's Open — show the `_inbox/`
 *  note save_voice_capture wrote (its vault-relative path). */
export const SPOTLIGHT_OPEN_INBOX_EVENT = "myco://spotlight-open-inbox";
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
  /** Nothing cleared the relevance floor: `answer` is advice, not a quote,
   *  and the spotlight says it has no evidence instead of showing it. */
  abstained?: boolean;
  /** The dated question's window, named in the abstention. */
  range?: { start: string; end: string };
  /** Stopped with ■ on the Ask page before the answer came back. */
  stopped?: boolean;
  /** Each quoted note's similarity (null: a keyword-only match), shown under
   *  the answer's details, not beside the quote (UX S14.7). */
  relevance?: { stem: string; similarity: number | null }[];
}

/** The finished turn as the spotlight gets it. Only a turn that quoted
 *  something is `extractive` — an empty one's body is advice ("nothing
 *  found", "reindex"), and labelling it "from your notes, verbatim" is the
 *  one thing an answer that quotes the vault or says nothing must not do. */
export function spotlightAnswerOf(question: string, turn: ChatTurn | undefined): SpotlightAnswer {
  return {
    question,
    answer: turn?.a ?? "",
    error: turn?.error,
    extractive: turn?.extractive && !turn.extractiveEmpty,
    abstained: turn?.abstained,
    range: turn?.range,
    stopped: turn?.stopped,
    relevance: turn?.hits
      ? groupByPage(turn.hits, QUOTED_PAGES).map((g) => ({ stem: g.stem, similarity: g.best }))
      : undefined,
  };
}

/** Wire the main window's half: answer the spotlight's questions and follow
 *  its citation, "Open in Ask" and written-question Open clicks. Call ONCE,
 *  from the main window only. Returns a teardown. Safe in a plain browser (no
 *  event bus): it just does nothing. */
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
    // Its own turn, as ask() ended it: by the time it settles the last turn
    // may be another question's (■, then the Ask page asking on).
    void useQueryStore
      .getState()
      .ask(question, lang, askCopy(t))
      .then((turn) => reply(spotlightAnswerOf(question, turn)));
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

  subscribe(SPOTLIGHT_OPEN_ASK_EVENT, () => useUIStore.getState().setRoute("query"));

  // The path is another webview's word: only this vault's daily note opens.
  subscribe<Captured | null>(SPOTLIGHT_OPEN_DAILY_EVENT, (written) => {
    const vault = useVaultStore.getState().currentVault?.path;
    if (vault && written && typeof written === "object") openCaptured(vault, written);
  });

  subscribe<unknown>(SPOTLIGHT_OPEN_INBOX_EVENT, (rel) => {
    const vault = useVaultStore.getState().currentVault?.path;
    if (vault) openInboxDoc(vault, rel);
  });

  return () => {
    cancelled = true;
    for (const u of unlisteners) u();
    unlisteners.length = 0;
  };
}
