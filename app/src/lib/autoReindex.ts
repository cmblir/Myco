// Keep the embedding index up to date with the vault, while the app is open.
//
// Everything the semantic layer feeds — palette hits, the Related panel, the
// graph's similarity edges, and what Ask retrieves before answering — reads an
// index that only a button in Settings ever built. Edit a page and all of it
// silently describes the vault as it was at the last manual reindex. The
// expensive half of fixing that is already done: reindex skips a page whose
// chunk hashes are unchanged, so maintaining an index costs one page's
// embedding, not the vault's.
//
// Opt-in and off by default, like the other background work here (auto-ingest,
// auto-reflect). Not a default because the first run is genuinely expensive —
// it loads 769 MB of weights (~11.7 s cold) and embeds every page — and doing
// that unannounced because someone saved a note would be a poor trade for a
// feature they had not asked for.

import { useEffect, useRef } from "react";
import { ipc } from "./ipc";
import { useIngestStore } from "../stores/ingestStore";
import { useReindexStore } from "../stores/reindexStore";

/** How long the vault must sit still before reindexing. */
const QUIET_MS = 10_000;
/** How often to look for a change. */
const POLL_MS = 4_000;

function ingestBusy(): boolean {
  const s = useIngestStore.getState().stage;
  return s === "writing-raw" || s === "claude" || s === "indexing";
}

/// One poll's worth of decision-making, as a pure-ish step over explicit state.
///
/// Split out from the hook so it is testable without a React renderer (the repo
/// has no renderer in its test deps, and the decisions — not the wiring — are
/// what can be wrong here).
export interface AutoReindexState {
  /** Vault + revision as of the last poll, or null before the first. */
  seen: { vault: string; revision: number } | null;
  /** When the vault last changed, or null if it has been still since baseline. */
  quietSince: number | null;
}

export type AutoReindexAction = "wait" | "reindex";

export interface PollInput {
  vault: string;
  revision: number;
  now: number;
  /** Pages already in the index. 0 means the user never built one. */
  indexedPages: number;
}

/**
 * Decide what this poll should do, and what to remember.
 *
 * - First sight of a vault only takes a baseline: opening a vault is not an
 *   edit, and reindexing on open is not what "keep it up to date" promises.
 * - A moved revision restarts the quiet window rather than reindexing mid-edit,
 *   which would fight the editor for the model.
 * - An empty index is left alone: the first build is minutes plus a 769 MB model
 *   load, so it stays the Settings button's decision, not a side effect of
 *   saving a note.
 */
export function decidePoll(
  state: AutoReindexState,
  input: PollInput,
): { action: AutoReindexAction; next: AutoReindexState } {
  const { vault, revision, now, indexedPages } = input;
  if (!state.seen || state.seen.vault !== vault) {
    return { action: "wait", next: { seen: { vault, revision }, quietSince: null } };
  }
  if (state.seen.revision !== revision) {
    return { action: "wait", next: { seen: { vault, revision }, quietSince: now } };
  }
  if (state.quietSince === null) return { action: "wait", next: state };
  if (now - state.quietSince < QUIET_MS) return { action: "wait", next: state };
  if (indexedPages === 0) {
    // Nothing to maintain. Drop the window so this does not re-ask every tick.
    return { action: "wait", next: { seen: state.seen, quietSince: null } };
  }
  return { action: "reindex", next: { seen: state.seen, quietSince: null } };
}

/**
 * React hook: reindex once the vault has been quiet for a moment after a change.
 *
 * Driven by `vault_revision` (a stat-only hash) rather than a timer: a timer
 * either reindexes a vault nobody touched or waits after one that changed. It
 * stands down entirely while an ingest is running — that flow writes many pages
 * and reindexes at the end itself.
 */
export function useAutoReindexScheduler(
  enabled: boolean,
  vaultPath: string | undefined,
): void {
  // Survives re-renders without restarting the poll.
  const state = useRef<AutoReindexState>({ seen: null, quietSince: null });

  useEffect(() => {
    if (!enabled || !vaultPath) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (ingestBusy()) return;
      // reindexStore's own guard would reject a second run anyway; skipping here
      // keeps this from resetting the quiet window under a run in progress.
      const stage = useReindexStore.getState().stage;
      if (stage === "loading-model" || stage === "indexing") return;

      let revision: number;
      let indexedPages: number;
      try {
        revision = await ipc.vaultRevision(vaultPath);
        indexedPages = (await ipc.embeddingsStatus()).indexed_pages;
      } catch {
        return; // vault closed or unreadable — try again next tick
      }
      if (cancelled) return;

      const { action, next } = decidePoll(state.current, {
        vault: vaultPath,
        revision,
        now: Date.now(),
        indexedPages,
      });
      state.current = next;
      if (action === "reindex") void useReindexStore.getState().reindex();
    };

    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, vaultPath]);
}
