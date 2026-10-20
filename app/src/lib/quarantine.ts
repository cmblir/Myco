// Quarantine review (ROADMAP P0). The distill gate moves off-topic inflow to
// `_inbox/quarantine/` with a `<stem>.verdict.json` sidecar and, until now, the
// app only ever showed a count — items sat there unseen. This module holds the
// shape `list_quarantine` returns plus the one piece of real logic on the TS
// side: turning a verdict into a sentence a human can act on.

import type { Strings } from "./i18n";

/** One `_inbox/quarantine/` item, straight off the `list_quarantine` command.
 *  Every sidecar field degrades independently Rust-side (see
 *  `distill::quarantine_entries`): a malformed sidecar still lists its item,
 *  with `s_knn`/`expires` at 0 and `reason` empty. */
export interface QuarantineItem {
  /** Vault-relative, e.g. `_inbox/quarantine/some-note.md`. */
  path: string;
  name: string;
  /** Cosine similarity to the nearest cluster at scan time; 0 if unknown. */
  s_knn: number;
  nearest_cluster: string;
  /** `ontology::describe`'s English sentence, verbatim — the only place the
   *  threshold `s_knn` was compared against is recorded. */
  reason: string;
  /** Unix seconds after which a distill run trashes this, or asks first
   *  (`asks_on_expiry`); 0 if unknown. */
  expires: number;
  /** Whether that run only makes a delete proposal (any session, an item of
   *  unknown origin, everything at Conservative): the backend's own rule,
   *  `distill::expiry_asks`. */
  asks_on_expiry: boolean;
  /** One-line body preview (frontmatter stripped, whitespace collapsed). */
  preview: string;
}

/** The quarantine threshold out of a verdict `reason` — the sidecar has no
 *  field for it, and `ontology::describe` is the only thing that ever knew it:
 *  "…similarity 0.42 >= quarantine 0.38 (p5) -> quarantine; 1 known entity".
 *  null when the reason is empty, malformed, or from the junk path (which
 *  never involves a threshold at all). */
export function verdictThreshold(reason: string): number | null {
  const m = /quarantine (\d+(?:\.\d+)?)/.exec(reason);
  return m ? Number(m[1]) : null;
}

/** The verdict as one sentence with the real numbers, e.g.
 *  "Off-topic: similarity 0.42 vs threshold 0.38 (nearest topic: rope)".
 *  Falls back progressively — no threshold in the reason drops that clause, no
 *  numbers at all falls back to the raw reason, and an empty reason (malformed
 *  sidecar) says exactly that instead of inventing a score. */
export function verdictSentence(item: QuarantineItem, t: Strings): string {
  if (!item.reason && item.s_knn === 0) {
    return t.qz_verdict_unknown ?? "No verdict recorded for this item.";
  }
  const threshold = verdictThreshold(item.reason);
  const numbers =
    threshold === null
      ? (t.qz_verdict_sim ?? "similarity {sim}").replace("{sim}", item.s_knn.toFixed(2))
      : (t.qz_verdict_sim_vs ?? "similarity {sim} vs threshold {min}")
          .replace("{sim}", item.s_knn.toFixed(2))
          .replace("{min}", threshold.toFixed(2));
  const head = (t.qz_verdict_offtopic ?? "Off-topic: {numbers}").replace(
    "{numbers}",
    numbers,
  );
  return item.nearest_cluster
    ? `${head} ${(t.qz_verdict_nearest ?? "(nearest topic: {topic})").replace("{topic}", item.nearest_cluster)}`
    : head;
}

/** Days left before the TTL sweep may trash this item, rounded up; null when
 *  the sidecar carries no expiry (malformed), and 0 once it is already due. */
export function daysLeft(item: QuarantineItem, nowMs: number = Date.now()): number | null {
  if (!item.expires) return null;
  return Math.max(0, Math.ceil((item.expires * 1000 - nowMs) / 86_400_000));
}

/** The TTL line: how long this item still has, and once it is due, what the
 *  next run does with it. Only an item the backend says it trashes reads
 *  "may move it to trash". A malformed sidecar has no expiry at all — say so
 *  rather than implying it is safe forever. */
export function ttlLine(item: QuarantineItem, t: Strings, nowMs: number = Date.now(), permanent = false): string {
  const left = daysLeft(item, nowMs);
  if (left === null) return t.qz_expires_unknown ?? "No expiry recorded";
  if (left > 0) return (t.qz_expires_in ?? "{n} days left").replace("{n}", String(left));
  return item.asks_on_expiry === false
    ? (permanent ? t.qz_expires_due_permanent : t.qz_expires_due ?? "Expired — the next run may move it to trash")
    : (t.qz_expires_due_ask ?? "Expired — the next run asks you under Proposals before deleting it");
}

/** How many days "keep longer" adds. One knob, not a picker — the TTL itself
 *  is configurable in Settings; this is just a reprieve. */
export const KEEP_DAYS = 30;

/** Why an item sits in quarantine, as the tab groups it: the provenance kinds
 *  `distill::scan` writes as `machine:<kind>` (spec 2026-10-02 결정 1), and
 *  everything else (similarity, a malformed sidecar) as `other`. */
export type QuarantineGroupKey = "myco" | "agent" | "hello" | "empty" | "other";

export interface QuarantineGroup {
  key: QuarantineGroupKey;
  items: QuarantineItem[];
}

const GROUP_ORDER: QuarantineGroupKey[] = ["myco", "agent", "hello", "empty", "other"];

/** The tab's groups, fixed order, empty ones left out. Each keeps the order the
 *  backend listed its items in (soonest expiry first). */
export function groupQuarantine(items: QuarantineItem[]): QuarantineGroup[] {
  const keyOf = (reason: string): QuarantineGroupKey => {
    const kind = reason.startsWith("machine:") ? reason.slice(8) : "";
    return (GROUP_ORDER as string[]).includes(kind) ? (kind as QuarantineGroupKey) : "other";
  };
  return GROUP_ORDER.map((key) => ({
    key,
    items: items.filter((i) => keyOf(i.reason) === key),
  })).filter((g) => g.items.length > 0);
}

export function groupLabel(key: QuarantineGroupKey, t: Strings): string {
  switch (key) {
    case "myco":
      return t.qz_group_myco ?? "Records of myco calling a model";
    case "agent":
      return t.qz_group_agent ?? "Agent task prompts";
    case "hello":
      return t.qz_group_hello ?? "Connection tests";
    case "empty":
      return t.qz_group_empty ?? "Empty sessions";
    default:
      return t.qz_group_other ?? "Other items";
  }
}

/** The in-page confirmation a group's "restore all" / "trash all" opens. */
export function batchConfirm(
  action: "restore" | "trash",
  group: QuarantineGroup,
  t: Strings,
  permanent = false,
): { title: string; message: string; confirmLabel: string; danger: boolean } {
  const n = String(group.items.length);
  const label = groupLabel(group.key, t);
  if (action === "restore") {
    return {
      title: (t.qz_confirm_restore_all_title ?? "Restore all {n}?").replace("{n}", n),
      message: (
        t.qz_confirm_restore_all_msg ??
        "Everything in “{group}” goes back where it came from and won't be set aside again."
      ).replace("{group}", label),
      confirmLabel: t.qz_restore_all ?? "Restore all",
      danger: false,
    };
  }
  if (permanent) {
    return {
      title: t.sb_delete_n_q.replace("{n}", n),
      message: t.delete_permanent_msg.replace("{n}", n),
      confirmLabel: t.set_delete_permanent,
      danger: true,
    };
  }
  return {
    title: (t.qz_confirm_trash_all_title ?? "Trash all {n}?").replace("{n}", n),
    message: (
      t.qz_confirm_trash_all_msg ??
      "Everything in “{group}” goes to the system trash (recoverable from there)."
    ).replace("{group}", label),
    confirmLabel: t.qz_trash_all ?? "Trash all",
    danger: true,
  };
}
