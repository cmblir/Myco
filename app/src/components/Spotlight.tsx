// The global-shortcut spotlight window's entire UI: one input, and the answer
// under it. A SECOND webview with its own JS context — it has no vault open and
// no queryStore, so it answers nothing itself. Enter emits the question and the
// main window runs the same `useQueryStore.ask` the Ask page runs (see
// lib/spotlight.ts); this file only renders what comes back.
//
// Palette is hardcoded dark, like the tray popover: a floating OS-level card is
// its own surface, not a themed page, and that keeps the app's theme/accent
// plumbing out of this webview entirely. Only the language is read (from the
// persisted uiStore, which shares localStorage with the main window).

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import Viewer from "./Viewer";
import { ipc } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import { isComposingKey } from "../lib/ime";
import {
  SPOTLIGHT_ANSWER_EVENT,
  SPOTLIGHT_ASK_EVENT,
  SPOTLIGHT_OPEN_EVENT,
  SPOTLIGHT_OPENED_EVENT,
  type SpotlightAnswer,
} from "../lib/spotlight";
import { useUIStore } from "../stores/uiStore";

/** In a plain browser, `?window=spotlight&mock=1` makes devMock answer the ask
 *  event with a canned extractive turn — that is how this window is looked at
 *  without the native shell (the real global keypress cannot be). */
export default function Spotlight(): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang];
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SpotlightAnswer | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // The window itself is transparent; only the rounded card paints.
    document.documentElement.classList.add("spotlight-window");
    inputRef.current?.focus();
    let unlisteners: (() => void)[] = [];
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => [
        await listen<SpotlightAnswer>(SPOTLIGHT_ANSWER_EVENT, (e) => {
          setBusy(false);
          setResult(e.payload);
        }),
        // Reopened via the shortcut: the window is reused, so the previous
        // question would still be sitting in the input.
        await listen(SPOTLIGHT_OPENED_EVENT, () => {
          setQuestion("");
          setResult(null);
          setBusy(false);
          inputRef.current?.focus();
        }),
      ])
      .then((us) => {
        if (cancelled) us.forEach((u) => u());
        else unlisteners = us;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  // Fit the OS window to the card: it is one input tall when empty and much
  // taller with an answer, and the window is transparent AND always-on-top —
  // leftover height is an invisible surface eating clicks meant for whatever is
  // underneath. Same measure-and-report pattern as the tray popover.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = 0;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.offsetHeight);
      if (h > 0 && h !== last) {
        last = h;
        void ipc.resizeSpotlight(h).catch(() => {
          /* plain-browser dev: no Tauri backend */
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // Mount-once: the card div is the same node in every render branch.
  }, []);

  const close = (): void => {
    void ipc.closeSpotlight().catch(() => {
      /* plain-browser dev: no Tauri backend */
    });
  };

  const ask = (): void => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setResult(null);
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit(SPOTLIGHT_ASK_EVENT, q))
      .catch(() => {
        // No bus means no answer is ever coming — don't spin forever.
        setBusy(false);
      });
  };

  // A citation opens the app on that note: close first, then let the main
  // window resolve the link (it owns the file tree and the router).
  const openCitation = (target: string): void => {
    close();
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit(SPOTLIGHT_OPEN_EVENT, target))
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
  };

  return (
    <div className="spotlight-card" ref={cardRef}>
      <div className="spotlight-input-row">
        <span aria-hidden className="spotlight-glyph">
          ✳
        </span>
        <input
          ref={inputRef}
          className="spotlight-input"
          value={question}
          placeholder={t.spot_placeholder ?? "Ask the wiki…"}
          aria-label={t.spot_placeholder ?? "Ask the wiki…"}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Esc closes; Enter asks — but never mid-IME-composition, where
            // Enter is the user committing Korean/Japanese input.
            if (e.key === "Escape") {
              e.preventDefault();
              close();
              return;
            }
            if (e.key === "Enter" && !isComposingKey(e.nativeEvent)) {
              e.preventDefault();
              ask();
            }
          }}
        />
        {busy ? (
          <span className="spotlight-status" role="status">
            {t.spot_thinking ?? "asking…"}
          </span>
        ) : null}
      </div>

      {result?.error ? (
        <div className="spotlight-body spotlight-error" role="alert">
          {result.error}
        </div>
      ) : null}

      {result && !result.error ? (
        <div className="spotlight-body">
          {result.extractive ? (
            <div className="spotlight-label">
              {t.q_extractive_label ?? "From your notes (top matches, verbatim)"}
            </div>
          ) : null}
          <Viewer content={result.answer} onLinkClick={openCitation} />
          <div className="spotlight-hint">{t.spot_hint_open ?? ""}</div>
        </div>
      ) : null}

      {!result && !busy ? (
        <div className="spotlight-body spotlight-hint">
          {t.spot_hint_enter ?? ""}
        </div>
      ) : null}
    </div>
  );
}
