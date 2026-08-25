// The task detail panel — the edit surface for one task's scheduling fields.
// Clicking a task opens this; its checkbox completes it. Those used to be the
// same gesture, which meant the only way to change an existing task was to drag
// it between board columns or calendar days.
//
// Presentational: every change is handed up as a field patch, and the page owns
// the write (writeTaskFields) and the stale-scan rescan. The title is shown but
// not editable — the note is still where a task's wording lives, and the
// "open note" link goes there.

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import DatePicker from "./DatePicker";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { TaskItem } from "../lib/ipc";
import { isComposingKey } from "../lib/ime";
import {
  parseTaskMeta,
  type TaskField,
  type TaskMeta,
  type TaskStatus,
} from "../lib/taskLine";
import { parseDuration } from "../lib/taskDuration";
import { extractLinks, extractTags, stripTokens } from "../lib/taskTokens";
import { parseRecurrence } from "../lib/taskRecurrence";

const STATUSES: {
  status: TaskStatus;
  labelKey: keyof Strings;
  fallback: string;
}[] = [
  { status: "todo", labelKey: "tasks_col_todo", fallback: "To do" },
  { status: "doing", labelKey: "tasks_col_doing", fallback: "In progress" },
  { status: "blocked", labelKey: "tasks_col_blocked", fallback: "Blocked" },
  { status: "done", labelKey: "tasks_col_done", fallback: "Done" },
];

export default function TaskDetail({
  t,
  task,
  status,
  busy,
  onPatch,
  onStatus,
  onOpenNote,
  onClose,
}: {
  t: Strings;
  task: TaskItem;
  status: TaskStatus;
  busy: boolean;
  onPatch: (patch: Partial<Pick<TaskMeta, TaskField>>) => void;
  onStatus: (status: TaskStatus) => void;
  onOpenNote: () => void;
  onClose: () => void;
}): JSX.Element {
  const meta = parseTaskMeta(task.text);
  // Free-text fields keep a draft and commit on blur or Enter, so a write does
  // not fire on every keystroke (and a half-typed `2` is never saved as `2m`).
  const [estimate, setEstimate] = useState(meta.estimate);
  const [recur, setRecur] = useState(meta.recur);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Each picker names its own field: three date triggers in one panel, and a
  // button is not labelled by the <label> that wraps it.
  const startLabel = t.tasks_detail_start ?? "Start";
  const scheduledLabel = t.tasks_detail_scheduled ?? "Scheduled";
  const dueLabel = t.tasks_due ?? "Due date";

  const estimateBad =
    estimate.trim() !== "" && parseDuration(estimate) === null;
  const recurBad = recur.trim() !== "" && parseRecurrence(recur) === null;
  const startAfterDue =
    meta.start !== "" && meta.due !== "" && meta.start > meta.due.slice(0, 10);

  const commit = (
    field: "estimate" | "recur",
    value: string,
    bad: boolean,
  ): void => {
    const next = value.trim();
    // An unreadable estimate would become a token nothing can read back, so it
    // is held in the field until it parses. An unreadable recurrence rule IS
    // written: Obsidian Tasks understands rules myco does not, and dropping the
    // user's text would lose it.
    if (field === "estimate" && bad) return;
    if (next !== meta[field]) onPatch({ [field]: next });
  };

  const textField = (
    field: "estimate" | "recur",
    value: string,
    set: (v: string) => void,
    bad: boolean,
    placeholder: string,
  ): JSX.Element => (
    <input
      className="input"
      value={value}
      placeholder={placeholder}
      disabled={busy}
      aria-invalid={bad || undefined}
      onChange={(e) => set(e.target.value)}
      onBlur={() => commit(field, value, bad)}
      onKeyDown={(e) => {
        if (isComposingKey(e)) return;
        if (e.key === "Enter") commit(field, value, bad);
      }}
    />
  );

  return (
    <div
      className="task-detail"
      role="dialog"
      aria-label={t.tasks_detail ?? "Task"}
      data-testid="task-detail"
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <header className="task-detail-head">
        <strong style={{ flex: 1, minWidth: 0 }}>
          {t.tasks_detail ?? "Task"}
        </strong>
        <button
          className="btn btn-ghost"
          onClick={onClose}
          aria-label={t.tasks_detail_close ?? "Close"}
        >
          <Icon name="x" size={12} />
        </button>
      </header>

      <p className="task-detail-title">
        {stripTokens(meta.title) || meta.title}
      </p>
      {(() => {
        const tags = extractTags(meta.title);
        const links = extractLinks(meta.title);
        if (tags.length === 0 && links.length === 0) return null;
        return (
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            {tags.map((tag) => (
              <span key={`#${tag}`} className="chip" style={{ fontSize: 11 }}>
                #{tag}
              </span>
            ))}
            {links.map((link) => (
              <span
                key={`[[${link}`}
                className="chip"
                style={{ fontSize: 11, color: "var(--c-overview)" }}
              >
                {link}
              </span>
            ))}
          </div>
        );
      })()}

      <div
        className="segmented"
        role="group"
        aria-label={t.tasks_detail_status ?? "Status"}
      >
        {STATUSES.map((s) => (
          <button
            key={s.status}
            className={status === s.status ? "active" : ""}
            disabled={busy}
            aria-pressed={status === s.status}
            onClick={() => onStatus(s.status)}
          >
            {(t[s.labelKey] as string | undefined) ?? s.fallback}
          </button>
        ))}
      </div>

      <label className="task-detail-field">
        <span>{startLabel}</span>
        <DatePicker
          t={t}
          label={startLabel}
          value={meta.start}
          onChange={(v) => onPatch({ start: v })}
          disabled={busy}
        />
      </label>
      <label className="task-detail-field">
        <span>{scheduledLabel}</span>
        <DatePicker
          t={t}
          label={scheduledLabel}
          value={meta.scheduled}
          onChange={(v) => onPatch({ scheduled: v })}
          disabled={busy}
        />
      </label>
      <label className="task-detail-field">
        <span>{dueLabel}</span>
        <DatePicker
          t={t}
          label={dueLabel}
          // The picker's contract is a bare day; a `THH:MM` on the line is kept
          // by the writer, so editing another field cannot silently drop it.
          value={meta.due.slice(0, 10)}
          onChange={(v) => onPatch({ due: v })}
          disabled={busy}
        />
      </label>

      {startAfterDue ? (
        <p className="task-detail-warn" data-testid="task-detail-warn">
          {t.tasks_detail_start_after_due ??
            "Start is after the due date, so this task shows on its due day. Your dates are left as written."}
        </p>
      ) : null}

      <label className="task-detail-field">
        <span>{t.tasks_detail_priority ?? "Priority"}</span>
        <select
          className="input"
          value={meta.priority}
          disabled={busy}
          onChange={(e) => onPatch({ priority: Number(e.target.value) })}
        >
          <option value={0}>{t.tasks_detail_priority_none ?? "None"}</option>
          <option value={1}>p1</option>
          <option value={2}>p2</option>
          <option value={3}>p3</option>
        </select>
      </label>

      <label className="task-detail-field">
        <span>{t.tasks_detail_estimate ?? "Estimate"}</span>
        {textField("estimate", estimate, setEstimate, estimateBad, "2d")}
      </label>
      {estimateBad ? (
        <p className="task-detail-warn">
          {t.tasks_detail_estimate_hint ??
            "Use a duration like 90m, 1.5h, 2d or 1w."}
        </p>
      ) : null}

      <label className="task-detail-field">
        <span>{t.tasks_detail_recur ?? "Repeat"}</span>
        {textField("recur", recur, setRecur, recurBad, "every week")}
      </label>
      {recurBad ? (
        <p className="task-detail-warn">
          {t.tasks_detail_recur_hint ??
            "myco schedules “every day/week/month/year” and “every 2 weeks”. Other rules stay in the note untouched."}
        </p>
      ) : null}

      <button className="btn btn-ghost task-detail-note" onClick={onOpenNote}>
        <Icon name="file" size={12} />
        {(t.tasks_detail_open_note ?? "Open {page}").replace(
          "{page}",
          task.stem,
        )}
      </button>
    </div>
  );
}
