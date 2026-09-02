// Reader properties panel: the note's frontmatter as a form. Typed controls
// for the keys the vault's validator knows (type/status/confidence/
// source_count/tags), a text field for other scalars, read-only for anything
// the line-based YAML subset cannot edit. Every change is one `onPatch` call;
// the page turns it into a single editor transaction.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import ChipInput from "./ChipInput";
import type { Strings } from "../lib/i18n";
import { isComposingKey } from "../lib/ime";
import {
  FM_CONFIDENCE,
  FM_STATUS,
  FM_TYPES,
  parseScalar,
  tagsOf,
  type FmEntry,
  type FmPatch,
  type FmScalar,
  type Frontmatter,
} from "../lib/frontmatter";
import { useUIStore } from "../stores/uiStore";

const KEY_RE = /^[A-Za-z_][\w-]*$/;
const ENUMS = new Map<string, readonly string[]>([
  ["type", FM_TYPES],
  ["status", FM_STATUS],
  ["confidence", FM_CONFIDENCE],
]);

export default function PropertiesPanel({
  fm,
  allTags,
  onPatch,
  t,
}: {
  fm: Frontmatter | null;
  allTags: string[];
  onPatch: (p: FmPatch) => void;
  t: Strings;
}): JSX.Element {
  const collapsed = useUIStore((s) => s.propsCollapsed);
  const setCollapsed = useUIStore((s) => s.setPropsCollapsed);
  const [adding, setAdding] = useState(false);
  const entries = fm?.entries ?? [];
  const addRow = adding ? (
    <AddRow
      existing={entries.map((e) => e.key)}
      onAdd={(p) => {
        // The first property turns the Add-only line into a <details>;
        // a persisted collapsed state would hide the row just created.
        if (!entries.length) setCollapsed(false);
        onPatch(p);
      }}
      onDone={() => setAdding(false)}
      t={t}
    />
  ) : (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => setAdding(true)}
    >
      ＋ {t.props_add ?? "Add property"}
    </button>
  );
  function control(e: FmEntry): JSX.Element {
    const { key, value } = e;
    if (key === "tags" && value !== undefined)
      return (
        <ChipInput
          chips={tagsOf(fm)}
          setChips={(next) => onPatch({ tags: next })}
          suggestions={allTags}
          placeholder={t.props_tags_ph ?? "Add tag…"}
          listId="props-tags"
          disabled={false}
          prefix=""
          removeTitle={t.props_tag_remove ?? "Remove tag"}
        />
      );
    // Nested maps, block scalars and non-tag lists stay source-only.
    if (value === undefined || Array.isArray(value))
      return (
        <span className="muted" style={{ fontSize: 12.5 }}>
          {t.props_complex ?? "Complex value — edit in source"}
        </span>
      );
    const text = value === null ? "" : String(value);
    const options = ENUMS.get(key);
    if (options)
      return (
        <select
          className="input"
          aria-label={key}
          value={text}
          onChange={(ev) => onPatch({ [key]: ev.target.value })}
        >
          {[...new Set([...options, text])].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    return (
      <ScalarInput
        label={key}
        type={key === "source_count" ? "number" : "text"}
        value={text}
        onCommit={(v) => onPatch({ [key]: parseScalar(v) })}
      />
    );
  }

  // No frontmatter → no empty form, just the way to start one.
  if (!entries.length) return <div className="card-flat props">{addRow}</div>;
  return (
    <details
      className="card-flat props"
      open={!collapsed}
      onToggle={(e) => setCollapsed(!e.currentTarget.open)}
    >
      <summary>
        {t.props_title ?? "Properties"} · {entries.length}
      </summary>
      {entries.map((e, i) => (
        // A duplicated YAML key is legal input; the index keeps rows unique.
        <div key={`${i}:${e.key}`} className="props__row">
          <span className="props__key" title={e.key}>
            {e.key}
          </span>
          {control(e)}
          <button
            type="button"
            className="btn btn-ghost"
            aria-label={(t.props_remove ?? "Remove {key}").replace("{key}", e.key)}
            onClick={() => onPatch({ [e.key]: undefined })}
          >
            ×
          </button>
        </div>
      ))}
      {addRow}
    </details>
  );
}

/** Commits on blur/Enter when changed; Escape restores the current value.
 *  `parseScalar` on commit keeps `3` a number and `true` a boolean. */
function ScalarInput({
  label,
  type,
  value,
  onCommit,
}: {
  label: string;
  type: "text" | "number";
  value: string;
  onCommit: (text: string) => void;
}): JSX.Element {
  const [text, setText] = useState(value);
  // The doc can change underneath (undo, another edit): follow it.
  useEffect(() => setText(value), [value]);
  const commit = (): void => {
    if (text !== value) onCommit(text);
  };
  return (
    <input
      className="input"
      aria-label={label}
      type={type}
      min={type === "number" ? 0 : undefined}
      step={type === "number" ? 1 : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isComposingKey(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") setText(value);
      }}
    />
  );
}

function AddRow({
  existing,
  onAdd,
  onDone,
  t,
}: {
  existing: string[];
  onAdd: (p: Record<string, FmScalar>) => void;
  onDone: () => void;
  t: Strings;
}): JSX.Element {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <form
      className="props__row"
      onSubmit={(e) => {
        e.preventDefault();
        const k = key.trim();
        if (!KEY_RE.test(k) || existing.includes(k)) {
          setBad(true);
          return;
        }
        onAdd({ [k]: parseScalar(value) });
        onDone();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone();
      }}
    >
      <input
        className="input props__key"
        value={key}
        placeholder={t.props_key_ph ?? "key"}
        aria-invalid={bad || undefined}
        autoFocus
        onChange={(e) => {
          setKey(e.target.value);
          setBad(false);
        }}
      />
      <input
        className="input"
        value={value}
        placeholder={t.props_value_ph ?? "value"}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="btn">
        {t.props_add_confirm ?? "Add"}
      </button>
      {bad ? (
        <p role="alert" className="props__alert">
          {t.props_bad_key ??
            "Key must start with a letter, use only letters, digits, _ or -, and not already exist"}
        </p>
      ) : null}
    </form>
  );
}
