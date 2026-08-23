// In-app auto-ingest scheduler. While the app is open and the toggle is on, it
// periodically ingests pending sources from the vault's `_inbox/` folder using
// the normal ingest pipeline (the selected provider), then archives the source
// (its content is preserved in raw/<slug>.md, written during ingest).
//
// This complements the headless cron daemon (automation/autoingest.py): the
// daemon runs without the app open via your CLI; this runs while the app is open
// via whatever provider you've selected (CLI, myco Pro, …). Both watch the same
// `_inbox/` folder and see EVERY file in it (Q4 item 20a): .md goes straight in,
// documents/images/media route through sourceTextFor, unsupported formats are
// counted and left in place — never silently invisible.

import { useEffect } from "react";
import { ipc } from "./ipc";
import type { InboxEntry } from "./ipc";
import { classifyInboxEntry, sourceTextFor } from "./mediaIngest";
import type { InboxKind } from "./mediaIngest";
import { shouldPromote } from "./redaction";
import { useIngestStore } from "../stores/ingestStore";

function isBusy(): boolean {
  const s = useIngestStore.getState().stage;
  return s === "writing-raw" || s === "claude" || s === "indexing";
}

/** Every pending source file directly under `<vault>/_inbox/`, any extension. */
export async function listInboxEntries(vaultPath: string): Promise<InboxEntry[]> {
  try {
    return await ipc.listInboxEntries(vaultPath);
  } catch {
    return [];
  }
}

/** One row in the "waiting in _inbox" list, newest first. */
export interface PendingInboxRow {
  name: string;
  /** Absolute path (`<vault>/_inbox/<name>`). */
  path: string;
  ext: string;
  kind: InboxKind;
  /** Epoch seconds; null when the listing had no mtime for this file. */
  mtime: number | null;
  /** Arrived today (caller-local date) — the row the inflow "+N" points at. */
  today: boolean;
}

/** Pure derivation: sort pending entries newest first, flag today's arrivals,
 *  and classify each for the ext/unsupported chips. Files without a known
 *  mtime sort last. */
export function pendingInboxRows(
  entries: InboxEntry[],
  vaultPath: string,
  now: Date = new Date(),
): PendingInboxRow[] {
  const todayKey = now.toDateString();
  return entries
    .map((e) => {
      const m = e.mtime > 0 ? e.mtime : null;
      return {
        name: e.name,
        path: `${vaultPath}/${e.rel}`,
        ext: e.ext,
        kind: classifyInboxEntry(e.name),
        mtime: m,
        today: m != null && new Date(m * 1000).toDateString() === todayKey,
      };
    })
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
}

/** Outcome of one inbox pass. `ingested` is the old boolean ("ran a
 *  successful ingest"); `held` counts sources left waiting in `_inbox/`
 *  because the redaction scan flagged them (Q4 item 13) or because media
 *  arrived without a whisper CLI; `unsupported` counts formats no pipeline
 *  can read — left in place, but no longer invisible (Q4 item 20a). */
export interface InboxPassOutcome {
  ingested: boolean;
  held: number;
  unsupported: number;
}

/** Ingest the next pending inbox source that clears the redaction scan, then
 *  archive it. At most one ingest per pass. Skips when a run is already in
 *  flight. Flagged sources are skipped (left in `_inbox/`), not consumed, so
 *  the pass walks past them instead of jamming on the first one. */
export async function runInboxPass(vaultPath: string): Promise<InboxPassOutcome> {
  if (isBusy()) return { ingested: false, held: 0, unsupported: 0 };
  const entries = await listInboxEntries(vaultPath);
  if (entries.length === 0) return { ingested: false, held: 0, unsupported: 0 };

  // Q4 item 13 — the PII response mode; secrets always block (redaction.ts).
  // An unreadable settings file falls back to warn-only, the Rust default.
  const settings = await ipc.getSettings().catch(() => null);
  const piiQuarantine = settings?.pii_quarantine_enabled ?? false;

  let held = 0;
  let unsupported = 0;
  // One whisper preflight per pass, checked lazily when the first media file
  // comes up — media without whisper is held with a reason instead of failing
  // late inside transcribe_media.
  let whisperOk: boolean | null = null;

  for (const e of entries) {
    const kind = classifyInboxEntry(e.name);
    if (kind === "unsupported") {
      unsupported++;
      continue;
    }
    if (kind === "media") {
      if (whisperOk === null) {
        whisperOk = await ipc
          .whisperCheck()
          .then((s) => s.installed)
          .catch(() => false);
      }
      if (!whisperOk) {
        held++;
        continue;
      }
    }

    const path = `${vaultPath}/${e.rel}`;
    const text =
      kind === "md"
        ? await ipc.readFile(path).then((fc) => fc.raw, () => null)
        : await sourceTextFor(path, {
            provider: settings?.query_provider ?? "",
            model: settings?.query_model ?? "",
          }).catch(() => null);
    if (text == null) return { ingested: false, held, unsupported };

    // Scan BEFORE startIngest writes raw/<slug>.md — raw/ is immutable, so a
    // flagged write could never be unwound. An unscannable source fails
    // closed (held) for the same reason.
    const scan = await ipc.scanTextSecrets(text).catch(() => null);
    if (!scan || !shouldPromote(scan, piiQuarantine)) {
      held++;
      continue;
    }

    const title = e.name.replace(/\.[^.]+$/, "");
    // startIngest writes raw/<slug>.md from this content and runs the model.
    // headless: this pass runs unattended — the plan gate (a checkbox review
    // awaiting a user) would park the run forever, so it must never engage here.
    await useIngestStore.getState().startIngest(title, text, { headless: true });

    if (useIngestStore.getState().stage === "done") {
      // Archive the consumed source (never delete) — its content is also in
      // raw/<slug>.md now, but a preserved original matches the headless daemon
      // and means a later half-failure cannot lose it.
      await ipc.archiveInboxSource(path).catch(() => undefined);
      // Only now is the file really gone from _inbox/ — signal the pending
      // list (a stage-keyed refetch fires before this move lands).
      useIngestStore.getState().bumpInboxRev();
      return { ingested: true, held, unsupported };
    }
    // error / no-op: leave the source in _inbox to retry next pass
    return { ingested: false, held, unsupported };
  }
  return { ingested: false, held, unsupported };
}

/** React hook: drive runInboxPass on an interval while enabled. */
export function useAutoIngestScheduler(
  enabled: boolean,
  intervalMin: number,
  vaultPath: string | undefined,
): void {
  useEffect(() => {
    if (!enabled || !vaultPath || intervalMin <= 0) return;
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void runInboxPass(vaultPath);
    };
    // A short kick after enabling, then on the interval.
    const kick = window.setTimeout(tick, 4000);
    const id = window.setInterval(tick, intervalMin * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(id);
    };
  }, [enabled, intervalMin, vaultPath]);
}
