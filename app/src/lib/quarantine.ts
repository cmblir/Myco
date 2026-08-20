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
  /** Unix seconds the TTL sweep may trash this; 0 if unknown. */
  expires: number;
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

/** How many days "keep longer" adds. One knob, not a picker — the TTL itself
 *  is configurable in Settings; this is just a reprieve. */
export const KEEP_DAYS = 30;
