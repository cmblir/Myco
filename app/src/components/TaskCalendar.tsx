import { useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { TaskItem } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import { usePointerDrag } from "../lib/pointerDrag";
import { monthGrid, parseTaskMeta, today } from "../lib/taskLine";
import { layoutMonthBars, MAX_LANES } from "../lib/taskCalendar";

/// Month calendar over the same scanned tasks. The dates ARE the markers on the
/// line, so dragging a bar to another day rewrites that line — there is no
/// calendar store to drift from the notes.
///
/// A task with a start and a due draws as a bar across its days, wrapping at
/// the week boundary; one date alone draws as a single day. The arithmetic is
/// taskCalendar.ts (pure, tested); this file only draws what it returns.
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
  // A crowded week hides its extra bars behind a +N chip; clicking one lets
  // every lane through instead of opening a second surface to read them in.
  const [allLanes, setAllLanes] = useState(false);
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const days = monthGrid(month);
  const todayIso = today(now);

  const keyOf = (task: TaskItem): string => `${task.page}:${task.line}`;
  const byId = new Map(tasks.map((x) => [keyOf(x), x]));
  const metaById = new Map(tasks.map((x) => [keyOf(x), parseTaskMeta(x.text)]));

  const bars = layoutMonthBars(
    tasks.map((x) => {
      const meta = metaById.get(keyOf(x));
      return { key: keyOf(x), start: meta?.start ?? "", due: meta?.due ?? "" };
    }),
    days,
    allLanes ? Infinity : MAX_LANES,
  );

  // Scheduled (⏳) is a hint about when to work, not a commitment, so it gets a
  // dot on its day rather than a bar of its own.
  const scheduledOn = new Map<string, TaskItem[]>();
  // Nothing dated at all: shown in a strip below instead of being dropped.
  const undated: TaskItem[] = [];
  for (const task of tasks) {
    const meta = metaById.get(keyOf(task));
    if (meta?.scheduled) {
      const list = scheduledOn.get(meta.scheduled);
      if (list) list.push(task);
      else scheduledOn.set(meta.scheduled, [task]);
    }
    if (!meta?.start && !meta?.due && !task.done) undated.push(task);
  }

  // Pointer-based drag (see pointerDrag.ts for why not HTML5). A bar being
  // dragged must not have the other bars intercepting the drop: while a drag is
  // in flight the whole bar layer stops taking pointer events, so hit-testing
  // finds the day cell underneath.
  const drag = usePointerDrag((id, day) => {
    const task = byId.get(id);
    if (task) onReschedule(task, day);
  }, !busy);
  const over = drag.live?.target ?? null;
  const dragging = drag.live !== null;

  const dragProps = (
    task: TaskItem,
  ): Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onClick"> => ({
    onPointerDown: drag.start(keyOf(task)),
    onClick: () => {
      if (!drag.consumeClick()) onOpen(task);
    },
  });

  // Month name and weekday initials come from Intl in the app's own language —
  // not the OS locale, which is a different setting the user did not change here.
  const monthLabel = new Intl.DateTimeFormat(lang, {
    year: "numeric",
    month: "long",
  }).format(month);
  const weekdayFmt = new Intl.DateTimeFormat(lang, { weekday: "short" });

  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  return (
    <div data-testid="task-calendar">
      <div
        className="row"
        style={{ justifyContent: "space-between", marginTop: 16 }}
      >
        <strong style={{ fontSize: 14 }}>{monthLabel}</strong>
        <span className="row" style={{ gap: 4 }}>
          <button
            className="btn btn-ghost"
            onClick={() => setOffset((n) => n - 1)}
            aria-label="previous month"
          >
            <Icon name="chevL" size={12} />
          </button>
          <button className="btn btn-ghost" onClick={() => setOffset(0)}>
            {t.tasks_cal_today ?? "Today"}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => setOffset((n) => n + 1)}
            aria-label="next month"
          >
            <Icon name="chevR" size={12} />
          </button>
        </span>
      </div>

      <div className="task-cal task-cal-head" aria-hidden="true">
        {days.slice(0, 7).map((d) => (
          <span key={`wd-${d.getDay()}`}>{weekdayFmt.format(d)}</span>
        ))}
      </div>

      {weeks.map((week, w) => {
        const segments = bars.segments.filter((s) => s.weekIndex === w);
        const lanes = segments.reduce((n, s) => Math.max(n, s.lane + 1), 0);
        const hiddenCols = week
          .map((_, col) => bars.overflow[`${w}:${col}`] ?? 0)
          .map((hidden, col) => ({ col, hidden }))
          .filter((x) => x.hidden > 0);
        return (
          <div
            key={`w-${today(week[0])}`}
            className="task-cal-week"
            // The day cells grow with the bars stacked over them, so a busy
            // week is taller rather than clipping its own bars. The +N chips
            // take one more row under the last lane.
            style={{
              ["--lanes" as string]: lanes + (hiddenCols.length > 0 ? 1 : 0),
            }}
          >
            <div className="task-cal">
              {week.map((d) => {
                const iso = today(d);
                const dots = scheduledOn.get(iso) ?? [];
                return (
                  <div
                    key={iso}
                    className={
                      "task-cal-day" +
                      (d.getMonth() !== month.getMonth() ? " is-outside" : "") +
                      (iso === todayIso ? " is-today" : "") +
                      (over === iso ? " is-over" : "")
                    }
                    data-testid={`day-${iso}`}
                    data-drop={iso}
                    // Clicking empty space in a day prefills the add form's date,
                    // so "add something on the 12th" is one click plus typing.
                    onClick={(e) => {
                      if (e.target === e.currentTarget) onPickDay(iso);
                    }}
                  >
                    <span className="task-cal-top">
                      <span className="task-cal-num">{d.getDate()}</span>
                      {dots.length > 0 ? (
                        <span
                          className="task-cal-sched"
                          title={dots
                            .map((x) => metaById.get(keyOf(x))?.title)
                            .join("\n")}
                        >
                          {dots.map((x) => (
                            <i key={keyOf(x)} />
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className={"task-cal-bars" + (dragging ? " is-dragging" : "")}>
              {segments.map((s) => {
                const task = byId.get(s.key);
                const meta = metaById.get(s.key);
                if (!task || !meta) return null;
                // A start with no due is work that has begun and has no end
                // date yet — marked, not invented into a bar of some length.
                const openEnded = meta.start !== "" && meta.due === "";
                return (
                  <button
                    key={s.key}
                    className={
                      "task-cal-bar" +
                      (task.done ? " is-done" : "") +
                      (drag.live?.id === s.key ? " is-dragging" : "") +
                      (s.continuesLeft ? " is-cont-l" : "") +
                      (s.continuesRight ? " is-cont-r" : "")
                    }
                    style={{
                      gridColumn: `${s.startCol + 1} / span ${s.span}`,
                      gridRow: s.lane + 1,
                    }}
                    {...dragProps(task)}
                    title={meta.title}
                  >
                    {openEnded ? "▷ " : ""}
                    {meta.title}
                  </button>
                );
              })}
              {/* In the bar layer, not the day cell: a chip inside the cell sat
                  under the bars drawn over it and could never be clicked. */}
              {hiddenCols.map(({ col, hidden }) => (
                <button
                  key={`more-${col}`}
                  className="task-cal-more"
                  style={{ gridColumn: col + 1, gridRow: lanes + 1 }}
                  onClick={() => setAllLanes(true)}
                  data-testid={`more-${today(week[col])}`}
                >
                  {`+${hidden}`}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {undated.length > 0 ? (
        <section style={{ marginTop: 14 }}>
          <div
            className="section-title"
            style={{ fontSize: 13, marginBottom: 6 }}
          >
            {(t.tasks_cal_undated ?? "No due date ({n})").replace(
              "{n}",
              String(undated.length),
            )}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {undated.map((task) => (
              <button
                key={keyOf(task)}
                className={
                  "task-cal-item" +
                  (drag.live?.id === keyOf(task) ? " is-dragging" : "")
                }
                {...dragProps(task)}
              >
                {metaById.get(keyOf(task))?.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
