// What to notify about, decided as a pure function so the timer around it stays
// trivial. Two kinds, because a due DATE and a due TIME want different things:
//
//   - a morning digest, once a day: "3 due today, 1 overdue". A date has no
//     hour, so the only honest moment to raise it is a time the user picked.
//   - a per-item alarm for a task that named a time (`@2026-08-10T14:00`),
//     which fires at that time and only once.
//
// Both are deliberately quiet: nothing fires for a task already done, and the
// digest is skipped entirely when there is nothing due.

import type { TaskItem } from "./ipc";
import { parseTaskMeta, today } from "./taskLine";

/** Ids of alarms already raised, so a 5-minute timer does not renotify. */
export type SentIds = ReadonlySet<string>;

/** A stable id for one task's timed alarm. */
export function alarmId(task: TaskItem): string {
  return `${task.page}:${task.line}:${parseTaskMeta(task.text).due}`;
}

export interface Digest {
  overdue: number;
  dueToday: number;
}

/** Counts for the morning digest, or `null` when there is nothing to say. */
export function buildDigest(tasks: TaskItem[], now: Date = new Date()): Digest | null {
  const day = today(now);
  let overdue = 0;
  let dueToday = 0;
  for (const task of tasks) {
    if (task.done) continue;
    const { due } = parseTaskMeta(task.text);
    if (!due) continue;
    // A due time still belongs to its date for the daily count.
    const dueDay = due.slice(0, 10);
    if (dueDay < day) overdue += 1;
    else if (dueDay === day) dueToday += 1;
  }
  return overdue === 0 && dueToday === 0 ? null : { overdue, dueToday };
}

/** Whether the digest for `now`'s day is still owed, given the last day one was
 * sent (`""` when never). Fires only once the chosen hour has arrived, so a
 * morning digest never lands the night before. */
export function digestIsDue(now: Date, lastSentDay: string, hour: number): boolean {
  return now.getHours() >= hour && today(now) !== lastSentDay;
}

/** Tasks whose due TIME has passed and that have not been notified yet.
 * A task with only a date is never an alarm — that is the digest's job. */
export function dueAlarms(
  tasks: TaskItem[],
  now: Date,
  sent: SentIds,
): TaskItem[] {
  return tasks.filter((task) => {
    if (task.done) return false;
    const { due } = parseTaskMeta(task.text);
    if (!due.includes("T")) return false;
    if (sent.has(alarmId(task))) return false;
    // `due` is local wall-clock, which is how the user wrote it; `new Date` on a
    // string without a zone parses it as local, so no conversion is needed.
    const at = new Date(due);
    return !Number.isNaN(at.getTime()) && at.getTime() <= now.getTime();
  });
}
