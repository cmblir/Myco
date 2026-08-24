import { useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { TaskItem } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import { monthGrid, parseTaskMeta, today } from "../lib/taskLine";

/// Month calendar over the same scanned tasks. A due date IS the `@YYYY-MM-DD`
/// on the line, so dragging a card to another day rewrites that marker — there
/// is no calendar store to drift from the notes.
export default function TaskCalendar({
  t,
  tasks,
  busy,
  onReschedule,
  onPickDay,
  onOpen,
}: {
  t: Strings;
  tasks: TaskItem[];
  busy: boolean;
  onReschedule: (task: TaskItem, day: string) => void;
  onPickDay: (day: string) => void;
  onOpen: (task: TaskItem) => void;
}): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  // Which month is shown, as an offset from the current one, so "today" stays
  // correct across a session that runs past midnight.
  const [offset, setOffset] = useState(0);
  const [over, setOver] = useState<string | null>(null);
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const days = monthGrid(month);
  const todayIso = today(now);

  // Tasks that carry a due date, bucketed by day. Undated ones are shown in
  // their own strip below rather than silently dropped from this view.
  const byDay = new Map<string, TaskItem[]>();
  const undated: TaskItem[] = [];
  const byId = new Map(tasks.map((x) => [`${x.page}:${x.line}`, x]));
  for (const task of tasks) {
    const { due } = parseTaskMeta(task.text);
    if (!due) {
      if (!task.done) undated.push(task);
      continue;
    }
    const day = due.slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(task);
    else byDay.set(day, [task]);
  }

  const drop = (day: string) => (e: React.DragEvent): void => {
    e.preventDefault();
    setOver(null);
    const task = byId.get(e.dataTransfer.getData("text/plain"));
    if (task) onReschedule(task, day);
  };

  // Month name and weekday initials come from Intl in the app's own language —
  // not the OS locale, which is a different setting the user did not change here.
  const monthLabel = new Intl.DateTimeFormat(lang, { year: "numeric", month: "long" }).format(month);
  const weekdayFmt = new Intl.DateTimeFormat(lang, { weekday: "short" });

  return (
    <div data-testid="task-calendar">
      <div className="row" style={{ justifyContent: "space-between", marginTop: 16 }}>
        <strong style={{ fontSize: 14 }}>{monthLabel}</strong>
        <span className="row" style={{ gap: 4 }}>
          <button className="btn btn-ghost" onClick={() => setOffset((n) => n - 1)} aria-label="previous month">
            <Icon name="chevL" size={12} />
          </button>
          <button className="btn btn-ghost" onClick={() => setOffset(0)}>
            {t.tasks_cal_today ?? "Today"}
          </button>
          <button className="btn btn-ghost" onClick={() => setOffset((n) => n + 1)} aria-label="next month">
            <Icon name="chevR" size={12} />
          </button>
        </span>
      </div>

      <div className="task-cal task-cal-head" aria-hidden="true">
        {days.slice(0, 7).map((d) => (
          <span key={`wd-${d.getDay()}`}>{weekdayFmt.format(d)}</span>
        ))}
      </div>

      <div className="task-cal">
        {days.map((d) => {
          const iso = today(d);
          const items = byDay.get(iso) ?? [];
          const outside = d.getMonth() !== month.getMonth();
          return (
            <div
              key={iso}
              className={
                "task-cal-day" +
                (outside ? " is-outside" : "") +
                (iso === todayIso ? " is-today" : "") +
                (over === iso ? " is-over" : "")
              }
              data-testid={`day-${iso}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(iso);
              }}
              onDragLeave={() => setOver((s) => (s === iso ? null : s))}
              onDrop={drop(iso)}
              // Clicking empty space in a day prefills the add form's date, so
              // "add something on the 12th" is one click plus typing.
              onClick={(e) => {
                if (e.target === e.currentTarget) onPickDay(iso);
              }}
            >
              <span className="task-cal-num">{d.getDate()}</span>
              {items.map((task) => (
                <button
                  key={`${task.page}:${task.line}`}
                  className={"task-cal-item" + (task.done ? " is-done" : "")}
                  draggable={!busy}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", `${task.page}:${task.line}`);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onOpen(task)}
                  title={parseTaskMeta(task.text).title}
                >
                  {parseTaskMeta(task.text).title}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {undated.length > 0 ? (
        <section style={{ marginTop: 14 }}>
          <div className="section-title" style={{ fontSize: 13, marginBottom: 6 }}>
            {(t.tasks_cal_undated ?? "No due date ({n})").replace("{n}", String(undated.length))}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {undated.map((task) => (
              <button
                key={`${task.page}:${task.line}`}
                className="task-cal-item"
                draggable={!busy}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", `${task.page}:${task.line}`);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => onOpen(task)}
              >
                {parseTaskMeta(task.text).title}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
