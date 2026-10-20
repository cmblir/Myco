// The Ask composer's scope chip (UX S33): "Scope · My notes ▾" opens the
// three choices in place, each with a line saying what it searches, the
// default first. The AskScope values are the same as before; only the words
// changed.

import { useRef } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { AskScope } from "../lib/ipc";
import { scopeLabel } from "./SourceLadder";

const SCOPES: readonly AskScope[] = ["wiki", "sessions", "all"];

function scopeHint(t: Strings, scope: AskScope): string {
  switch (scope) {
    case "wiki":
      return t.q_scope_wiki_hint;
    case "sessions":
      return t.q_scope_sessions_hint;
    case "all":
      return t.q_scope_all_hint;
  }
}

export default function AskScopePicker({
  t,
  scope,
  disabled,
  onChange,
}: {
  t: Strings;
  scope: AskScope;
  disabled: boolean;
  onChange: (scope: AskScope) => void;
}): JSX.Element {
  const ref = useRef<HTMLDetailsElement>(null);
  // Picked or dismissed, the choices fold back under the chip, which keeps focus.
  const close = (): void => {
    const d = ref.current;
    if (!d) return;
    d.open = false;
    d.querySelector("summary")?.focus();
  };
  return (
    <details
      ref={ref}
      className="ask-scope"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !ref.current?.open) return;
        e.stopPropagation();
        close();
      }}
    >
      <summary id="ask-scope">
        {t.q_scope_chip.replace("{scope}", scopeLabel(t, scope))}
        <Icon name="chevD" size={12} />
      </summary>
      <div
        className="ask-scope__menu"
        role="group"
        aria-label={t.q_scope_label}
      >
        {SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={scope === s}
            disabled={disabled}
            onClick={() => {
              onChange(s);
              close();
            }}
          >
            <span className="ask-scope__name">
              {scopeLabel(t, s)}
              {scope === s ? <Icon name="check" size={14} /> : null}
            </span>
            <span className="ask-scope__hint">{scopeHint(t, s)}</span>
          </button>
        ))}
      </div>
    </details>
  );
}
