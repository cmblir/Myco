// Fires task notifications while the app is open, on the same shape as the
// other in-app schedulers (autoImport / scheduleTimer): a hook, an interval, and
// pure logic it defers to (taskNotify.ts).
//
// State lives in localStorage rather than vault settings on purpose —
// "have I already told you about this?" is per-device, and a second machine
// opening the same vault should get its own morning digest.

import { useEffect } from "react";
import { ipc } from "./ipc";
import { log } from "./log";
import { notify } from "./notify";
import { today } from "./taskLine";
import { alarmId, buildDigest, digestIsDue, dueAlarms } from "./taskNotify";
import { parseTaskMeta } from "./taskLine";

const CHECK_INTERVAL_MS = 5 * 60_000;
const ENABLED_KEY = "myco.tasks.notify";
const LAST_DIGEST_KEY = "myco.tasks.notify.lastDigestDay";
const SENT_KEY = "myco.tasks.notify.sent";
/** Hour of the morning digest. Not configurable yet — one number nobody has
 * asked to move is a setting that does not need to exist. */
const DIGEST_HOUR = 9;

/** Notifications are opt-IN: the app should not start alerting because a user
 * happened to write a due date. */
export function notifyEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNotifyEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* private mode / storage disabled — the toggle just will not persist */
  }
}

function readSent(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SENT_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSent(ids: Set<string>): void {
  try {
    // Alarm ids carry their due date, so yesterday's are dead weight: keep the
    // list bounded rather than growing it for the life of the install.
    const day = today();
    const live = [...ids].filter((id) => id.slice(-16).slice(0, 10) >= day);
    localStorage.setItem(SENT_KEY, JSON.stringify(live));
  } catch {
    /* non-fatal: worst case a notification repeats after a restart */
  }
}

/** One pass: raise the morning digest if it is owed, then any task whose due
 * time has arrived. Exported for the manual "test notification" path and so a
 * caller can force a check without waiting for the interval. */
export async function runTaskNotifyPass(vaultPath: string): Promise<void> {
  if (!notifyEnabled()) return;
  let tasks;
  try {
    tasks = await ipc.scanTasks(vaultPath);
  } catch (err) {
    log.warn("task_notify.scan_failed", { error: String(err) });
    return;
  }
  const now = new Date();

  try {
    const lastDay = localStorage.getItem(LAST_DIGEST_KEY) ?? "";
    if (digestIsDue(now, lastDay, DIGEST_HOUR)) {
      const digest = buildDigest(tasks, now);
      // Mark the day as handled either way: with nothing due there is nothing
      // to say, and retrying every 5 minutes would not change that.
      localStorage.setItem(LAST_DIGEST_KEY, today(now));
      if (digest) {
        const parts = [];
        if (digest.dueToday > 0) parts.push(`due today ${digest.dueToday}`);
        if (digest.overdue > 0) parts.push(`overdue ${digest.overdue}`);
        await notify("myco — tasks", parts.join(" · "));
      }
    }
  } catch (err) {
    log.warn("task_notify.digest_failed", { error: String(err) });
  }

  const sent = readSent();
  for (const task of dueAlarms(tasks, now, sent)) {
    await notify(parseTaskMeta(task.text).title, task.stem);
    sent.add(alarmId(task));
  }
  writeSent(sent);
}

/** React hook: check on an interval while a vault is open. */
export function useTaskNotifier(vaultPath: string | undefined): void {
  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void runTaskNotifyPass(vaultPath);
    };
    const kick = window.setTimeout(tick, 12_000);
    const id = window.setInterval(tick, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(id);
    };
  }, [vaultPath]);
}
