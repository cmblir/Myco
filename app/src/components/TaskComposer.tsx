// The task add form — a quick one-line row (title + due + 추가), expandable
// via 자세히 into the full field set: category #tags (suggested from the
// vault's existing tags), project [[links]] (suggested from wiki page stems),
// a target note (today's daily, or a roadmap page), and the same scheduling
// fields the detail panel edits. The page owns the write; this builds one line.

import { useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import DatePicker from "./DatePicker";
import type { Strings } from "../lib/i18n";
import { isComposingKey } from "../lib/ime";
import { serializeTaskText, type TaskMeta } from "../lib/taskLine";
import { composeTitle } from "../lib/taskTokens";
import { parseDuration } from "../lib/taskDuration";
import { parseRecurrence } from "../lib/taskRecurrence";
import { useVaultStore } from "../stores/vaultStore";

/** Where the new task line goes. */
export type ComposeTarget = { kind: "daily" } | { kind: "page"; path: string };

export interface ComposedTask {
  line: string;
  target: ComposeTarget;
}

/** Chip input with a datalist of suggestions — the platform's own
 *  autocomplete, no popover code. Enter/comma commits a chip. */
function ChipInput({
  chips,
  setChips,
  suggestions,
  placeholder,
  listId,
  disabled,
  prefix,
}: {
  chips: string[];
  setChips: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
  listId: string;
  disabled: boolean;
  prefix: string;
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
          title="remove"
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

export default function TaskComposer({
  t,
  busy,
  roadmaps,
  due,
  onDueChange,
  onAdd,
  onNewRoadmap,
}: {
  t: Strings;
  busy: boolean;
  /** `wiki/roadmaps/*` pages currently in the vault. */
  roadmaps: { path: string; stem: string }[];
  /** Due date is lifted to the page: the calendar prefills it by clicking a
   *  day, which predates the composer. */
  due: string;
  onDueChange: (iso: string) => void;
  onAdd: (task: ComposedTask) => void;
  /** Create a roadmap page; resolves its vault-relative path. */
  onNewRoadmap: (title: string) => Promise<string | null>;
}): JSX.Element {
  const adjacency = useVaultStore((s) => s.adjacency);
  const currentVault = useVaultStore((s) => s.currentVault);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [target, setTarget] = useState<string>("daily");
  const [start, setStart] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [priority, setPriority] = useState(0);
  const [estimate, setEstimate] = useState("");
  const [recur, setRecur] = useState("");
  const newRoadmapBusy = useRef(false);

  // Existing categories, most-used first — "is this related to something the
  // vault already has" is answered by the suggestion list itself.
  const tagSuggestions = useMemo(
    () =>
      Object.entries(adjacency?.tags ?? {})
        .sort((a, b) => b[1].length - a[1].length)
        .map(([tag]) => tag),
    [adjacency],
  );
  // Wiki page stems for the project link.
  const linkSuggestions = useMemo(() => {
    const root = currentVault?.path ?? "";
    return Object.keys(adjacency?.forward ?? {})
      .filter((p) => p.startsWith(`${root}/wiki/`))
      .map((p) => (p.split("/").pop() ?? "").replace(/\.md$/i, ""))
      .sort();
  }, [adjacency, currentVault]);

  const estimateBad =
    estimate.trim() !== "" && parseDuration(estimate) === null;
  const recurBad =
    recur.trim() !== "" && parseRecurrence(recur.trim()) === null;

  const add = (): void => {
    const text = draft.trim();
    if (!text || busy || estimateBad) return;
    const meta: TaskMeta = {
      title: composeTitle(text, tags, links),
      start,
      scheduled,
      due,
      doneAt: "",
      recur: recurBad ? "" : recur.trim(),
      estimate: estimate.trim(),
      priority,
    };
    onAdd({
      line: `- [ ] ${serializeTaskText(meta)}`,
      target:
        target === "daily" ? { kind: "daily" } : { kind: "page", path: target },
    });
    setDraft("");
    // Dates/fields intentionally kept: adding several items to one milestone
    // in a row shares its category, project and target.
  };

  const newRoadmap = async (): Promise<void> => {
    if (newRoadmapBusy.current) return;
    const title = window.prompt(t.tasks_new_roadmap_ph ?? "Roadmap title");
    if (!title?.trim()) return;
    newRoadmapBusy.current = true;
    try {
      const rel = await onNewRoadmap(title.trim());
      if (rel) setTarget(rel);
    } finally {
      newRoadmapBusy.current = false;
    }
  };

  return (
    <div
      className="card"
      style={{ padding: 12, marginTop: 8, marginBottom: 16 }}
    >
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <input
          className="input"
          style={{
            border: "none",
            padding: "4px 0",
            boxShadow: "none",
            flex: 1,
          }}
          placeholder={t.tasks_ph ?? "What do you have to do?"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingKey(e)) return;
            if (e.key === "Enter") add();
          }}
          disabled={busy}
          data-testid="task-input"
        />
        <DatePicker t={t} value={due} onChange={onDueChange} disabled={busy} />
        <button
          className="btn btn-ghost"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="task-composer-toggle"
        >
          {t.tasks_compose_more ?? "Details"}
        </button>
        <button
          className="btn btn-primary"
          onClick={add}
          disabled={busy || !draft.trim() || estimateBad}
        >
          {t.tasks_add ?? "Add"}
        </button>
      </div>

      {expanded ? (
        <div
          className="col"
          style={{ gap: 8, marginTop: 10 }}
          data-testid="task-composer-full"
        >
          <label className="task-detail-field">
            <span>{t.tasks_compose_category ?? "Category"}</span>
            <ChipInput
              chips={tags}
              setChips={setTags}
              suggestions={tagSuggestions}
              placeholder="#dev"
              listId="task-tags"
              disabled={busy}
              prefix="#"
            />
          </label>
          <label className="task-detail-field">
            <span>{t.tasks_compose_project ?? "Project"}</span>
            <ChipInput
              chips={links}
              setChips={setLinks}
              suggestions={linkSuggestions}
              placeholder="[[project]]"
              listId="task-links"
              disabled={busy}
              prefix=""
            />
          </label>
          <label className="task-detail-field">
            <span>{t.tasks_compose_target ?? "Add to"}</span>
            <select
              className="input"
              style={{ width: 220, flex: "none" }}
              value={
                target === "daily" || roadmaps.some((r) => r.path === target)
                  ? target
                  : "daily"
              }
              disabled={busy}
              onChange={(e) => {
                if (e.target.value === "__new__") void newRoadmap();
                else setTarget(e.target.value);
              }}
              data-testid="task-composer-target"
            >
              <option value="daily">
                {t.tasks_compose_daily ?? "Today's daily note"}
              </option>
              {roadmaps.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.stem}
                </option>
              ))}
              <option value="__new__">
                {t.tasks_new_roadmap ?? "＋ New roadmap…"}
              </option>
            </select>
          </label>
          <label className="task-detail-field">
            <span>{t.tasks_detail_start ?? "Start"}</span>
            <DatePicker
              t={t}
              label={t.tasks_detail_start ?? "Start"}
              value={start}
              onChange={setStart}
              disabled={busy}
            />
          </label>
          <label className="task-detail-field">
            <span>{t.tasks_detail_scheduled ?? "Scheduled"}</span>
            <DatePicker
              t={t}
              label={t.tasks_detail_scheduled ?? "Scheduled"}
              value={scheduled}
              onChange={setScheduled}
              disabled={busy}
            />
          </label>
          <label className="task-detail-field">
            <span>{t.tasks_detail_priority ?? "Priority"}</span>
            <select
              className="input"
              style={{ width: 150, flex: "none" }}
              value={priority}
              disabled={busy}
              onChange={(e) => setPriority(Number(e.target.value))}
            >
              <option value={0}>
                {t.tasks_detail_priority_none ?? "None"}
              </option>
              <option value={1}>p1</option>
              <option value={2}>p2</option>
              <option value={3}>p3</option>
            </select>
          </label>
          <label className="task-detail-field">
            <span>{t.tasks_detail_estimate ?? "Estimate"}</span>
            <input
              className="input"
              style={{ width: 150, flex: "none" }}
              value={estimate}
              placeholder="2d"
              aria-invalid={estimateBad || undefined}
              disabled={busy}
              onChange={(e) => setEstimate(e.target.value)}
            />
          </label>
          {estimateBad ? (
            <p className="task-detail-warn">
              {t.tasks_detail_estimate_hint ??
                "Use a duration like 90m, 1.5h, 2d or 1w."}
            </p>
          ) : null}
          <label className="task-detail-field">
            <span>{t.tasks_detail_recur ?? "Repeat"}</span>
            <input
              className="input"
              style={{ width: 150, flex: "none" }}
              value={recur}
              placeholder="every week"
              aria-invalid={recurBad || undefined}
              disabled={busy}
              onChange={(e) => setRecur(e.target.value)}
            />
          </label>
          {recurBad ? (
            <p className="task-detail-warn">
              {t.tasks_detail_recur_hint ??
                "myco schedules “every day/week/month/year” and “every 2 weeks”."}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
