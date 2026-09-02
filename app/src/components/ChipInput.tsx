// Chip input with a datalist of suggestions — the platform's own autocomplete,
// no popover code. Enter/comma commits a chip. Shared by the task composer and
// the reader's properties panel (tags).

import { useState } from "react";
import type { JSX } from "react";
import { isComposingKey } from "../lib/ime";

export default function ChipInput({
  chips,
  setChips,
  suggestions,
  placeholder,
  listId,
  disabled,
  prefix,
  removeTitle = "remove",
}: {
  chips: string[];
  setChips: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
  listId: string;
  disabled: boolean;
  prefix: string;
  removeTitle?: string;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const commit = (): void => {
    const v = draft.trim().replace(/^#/, "");
    if (v && !chips.includes(v)) setChips([...chips, v]);
    setDraft("");
  };
  return (
    <div
      className="row"
      style={{ gap: 4, flexWrap: "wrap", flex: 1, minWidth: 0 }}
    >
      {chips.map((c) => (
        <button
          key={c}
          type="button"
          className="chip"
          style={{ fontSize: 11.5, cursor: "pointer" }}
          title={removeTitle}
          disabled={disabled}
          onClick={() => setChips(chips.filter((x) => x !== c))}
        >
          {prefix}
          {c} ×
        </button>
      ))}
      <input
        className="input"
        style={{ flex: 1, minWidth: 120 }}
        list={listId}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
