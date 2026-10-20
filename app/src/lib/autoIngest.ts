// In-app auto-ingest scheduler. While the app is open and the toggle is on, it
// compiles pending Markdown through an exact-byte native snapshot and the
// captured compilation role. Only a checked native archive receipt can attest
// harvest completion. General documents, images and media remain pending until
// their native frozen-source compiler admission is available.

import { useEffect } from "react";
import { ipc } from "./ipc";
import type { AgentVaultSession, InboxEntry, InboxSourceSnapshot } from "./ipc";
import type { RoleUsage } from "./modelRoles";
import { classifyInboxEntry } from "./mediaIngest";
import type { InboxKind } from "./mediaIngest";
import { checkSourceText } from "./redaction";
import {
  useIngestStore,
  type InboxCompilationResult,
} from "../stores/ingestStore";
import { tryLock, unlock } from "./vaultLock";
import { notice } from "./notice";
import { STRINGS } from "./i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { runSessionPass } from "./sessionIngest";
import { WorkflowOperationError } from "./workflowOutcome";

function isBusy(): boolean {
  const s = useIngestStore.getState().stage;
  return (
    s === "writing-raw" ||
    s === "plan-gate" ||
    s === "claude" ||
    s === "indexing"
  );
}

/** Every pending source file directly under `<vault>/_inbox/`, any extension. */
export async function listInboxEntries(
  vaultPath: string,
): Promise<InboxEntry[]> {
  return ipc.listInboxEntries(vaultPath);
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

/** One pass's outcome. `ingested` records a completed native compile and
 * checked archive; `harvestCompleted` separately retains the native completion
 * receipt. `held` includes redaction holds and sources awaiting compiler
 * admission. `unsupported` counts unknown formats left in place. `refused`
 * counts checked no-context archives, which never attest harvest completion. */
export interface InboxPassOutcome {
  ingested: boolean;
  held: number;
  unsupported: number;
  refused: number;
  sourcePath?: string;
  pendingChunks?: number;
  error?: string;
  busy?: boolean;
  origin?: AgentVaultSession;
  sourceRevision?: string;
  harvestCompleted?: boolean;
  pendingReason?: string;
}

export interface InboxPassOptions {
  /** Process this exact pending copy; never fall back to an unrelated source. */
  sourcePath?: string;
  sourceRevision?: string;
  origin?: AgentVaultSession;
  expectedVaultToken?: string;
  usage?: RoleUsage;
}

/** Ingest the next pending inbox source that clears the redaction scan, then
 *  archive it. At most one ingest per pass. Skips when a run is already in
 *  flight, or a distill run holds the vault (the shared vault lock, held for
 *  the whole pass). Flagged sources are skipped (left in `_inbox/`), not
 *  consumed, so the pass walks past them instead of jamming on the first one. */
export async function runInboxPass(
  vaultPath: string,
  opts: InboxPassOptions = {},
): Promise<InboxPassOutcome> {
  const ui = useVaultStore.getState();
  const expectedVaultToken = opts.expectedVaultToken ?? ui.vaultToken;
  const isCurrent = (): boolean => {
    const current = useVaultStore.getState();
    return (
      !current.isOpeningVault &&
      current.currentVault?.path === vaultPath &&
      current.vaultToken === expectedVaultToken &&
      !!expectedVaultToken
    );
  };
  const identity = {
    ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}),
    ...(opts.sourceRevision ? { sourceRevision: opts.sourceRevision } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  };
  if (isBusy() || !tryLock(vaultPath)) {
    return {
      ingested: false,
      held: 0,
      unsupported: 0,
      refused: 0,
      busy: true,
      ...identity,
    };
  }
  try {
    if (!isCurrent())
      throw new Error("The originating vault opening is no longer active");
    const origin = Object.freeze(
      opts.origin ?? (await ipc.agentVaultSession()),
    );
    if (
      !isCurrent() ||
      origin.vaultPath !== vaultPath ||
      !origin.openingToken
    ) {
      throw new Error("The originating vault opening is no longer active");
    }
    return await inboxPass(
      vaultPath,
      { ...opts, origin, expectedVaultToken },
      isCurrent,
    );
  } catch (error) {
    return {
      ingested: false,
      held: 0,
      unsupported: 0,
      refused: 0,
      ...identity,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unlock(vaultPath);
  }
}

async function inboxPass(
  vaultPath: string,
  opts: InboxPassOptions & {
    origin: AgentVaultSession;
    expectedVaultToken: string;
  },
  isCurrent: () => boolean,
): Promise<InboxPassOutcome> {
  const ensureCurrent = (): void => {
    if (!isCurrent())
      throw new Error("The originating vault opening is no longer active");
  };
  const listed = await ipc.listInboxEntries(vaultPath);
  ensureCurrent();
  const entries = opts.sourcePath
    ? listed.filter((entry) => `${vaultPath}/${entry.rel}` === opts.sourcePath)
    : listed;
  if (opts.sourcePath && entries.length === 0)
    throw new Error("Requested inbox source is no longer pending");
  if (opts.sourceRevision && !/^[a-f0-9]{64}$/.test(opts.sourceRevision)) {
    throw new Error("Requested inbox source revision is invalid");
  }
  const identity = {
    origin: opts.origin,
    ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}),
    ...(opts.sourceRevision ? { sourceRevision: opts.sourceRevision } : {}),
  };
  const empty = {
    ingested: false,
    held: 0,
    unsupported: 0,
    refused: 0,
    ...identity,
  };
  if (entries.length === 0) return empty;
  const settings = await ipc.getSettings();
  ensureCurrent();
  let held = 0;
  let unsupported = 0;
  let refused = 0;
  for (const entry of entries) {
    const kind = classifyInboxEntry(entry.name);
    if (kind !== "md") {
      // Binary extraction and general source compilation need their own native
      // frozen-byte admission. No legacy Query route or derived marker grants it.
      if (kind === "unsupported") unsupported++;
      else held++;
      continue;
    }
    ensureCurrent();
    const snapshot: InboxSourceSnapshot = await ipc.inboxSourceSnapshot(
      opts.origin,
      entry.rel,
      opts.sourceRevision,
    );
    const processing = await (async (): Promise<InboxPassOutcome | null> => {
      ensureCurrent();
      if (
        snapshot.origin.vaultPath !== opts.origin.vaultPath ||
        snapshot.origin.openingToken !== opts.origin.openingToken ||
        snapshot.inboxRel !== entry.rel ||
        !snapshot.snapshotId ||
        !/^[a-f0-9]{64}$/.test(snapshot.sourceRevision) ||
        (opts.sourceRevision && snapshot.sourceRevision !== opts.sourceRevision)
      ) {
        throw new Error(
          "Inbox snapshot differs from its originating copy/opening",
        );
      }
      const sourcePath = `${vaultPath}/${snapshot.inboxRel}`;
      const bound = {
        sourcePath,
        sourceRevision: snapshot.sourceRevision,
        origin: snapshot.origin,
      };
      const title = entry.name.replace(/\.[^.]+$/, "");
      const check = await checkSourceText(
        `${title}\n\n${snapshot.text}`,
        ipc.scanTextSecrets,
        settings?.pii_quarantine_enabled ?? false,
      );
      ensureCurrent();
      if (!check.ok) {
        held++;
        return null;
      }
      const verdict = await ipc.judgeSource(
        snapshot.text,
        new TextEncoder().encode(snapshot.text).length,
      );
      ensureCurrent();
      if (verdict.verdict !== "harvest") {
        const receipt = await ipc.archiveInboxSourceChecked(snapshot);
        ensureCurrent();
        if (
          receipt.sourceRevision !== snapshot.sourceRevision ||
          receipt.harvestCompleted !== false
        ) {
          throw new Error(
            "Refused inbox archive did not retain its source revision/outcome",
          );
        }
        useIngestStore.getState().bumpInboxRev();
        refused++;
        return null;
      }
      let compiled: InboxCompilationResult;
      try {
        compiled = await useIngestStore
          .getState()
          .startInboxCompilation(snapshot, {
            usage: opts.usage ?? "automatic",
            expectedVaultToken: opts.expectedVaultToken,
          });
      } catch (error) {
        ensureCurrent();
        if (
          error instanceof WorkflowOperationError &&
          error.status === "pending"
        ) {
          return {
            ingested: false,
            held: held + 1,
            unsupported,
            refused,
            ...bound,
            pendingReason: error.message,
            harvestCompleted: false,
          };
        }
        throw error;
      }
      ensureCurrent();
      if (compiled.result.state !== "completed") {
        return {
          ingested: false,
          held: held + 1,
          unsupported,
          refused,
          ...bound,
          pendingChunks:
            compiled.result.eligibleWindows - compiled.result.nextPacket,
          pendingReason: "Native source compilation remains pending",
          harvestCompleted: false,
        };
      }
      const receipt = await ipc.archiveInboxSourceChecked(
        snapshot,
        compiled.context,
      );
      ensureCurrent();
      if (
        receipt.sourceRevision !== snapshot.sourceRevision ||
        typeof receipt.harvestCompleted !== "boolean"
      ) {
        throw new Error(
          "Inbox archive did not retain its source revision/completion result",
        );
      }
      useIngestStore.getState().bumpInboxRev();
      return {
        ingested: true,
        held,
        unsupported,
        refused,
        ...bound,
        pendingChunks: 0,
        harvestCompleted: receipt.harvestCompleted,
      };
    })().then(
      (outcome) => ({ ok: true as const, outcome }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const cleanupErrors: string[] = [];
    try {
      await ipc.releaseInboxSource(snapshot);
    } catch (error) {
      cleanupErrors.push(`Inbox snapshot release failed: ${String(error)}`);
    }
    try {
      ensureCurrent();
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (cleanupErrors.length) {
      const cause = processing.ok
        ? processing.outcome?.pendingReason
        : String(processing.error);
      throw new Error([...(cause ? [cause] : []), ...cleanupErrors].join("; "));
    }
    if (!processing.ok) throw processing.error;
    if (processing.outcome) return processing.outcome;
  }
  return {
    ingested: false,
    held,
    unsupported,
    refused,
    ...identity,
    ...(held > 0
      ? { pendingReason: "Source compiler admission remains pending" }
      : {}),
  };
}

/** React hook: drive runInboxPass on an interval while enabled. */
export function useAutoIngestScheduler(
  enabled: boolean,
  intervalMin: number,
  vaultPath: string | undefined,
): void {
  const vaultToken = useVaultStore((state) => state.vaultToken);
  useEffect(() => {
    if (!enabled || !vaultPath || intervalMin <= 0) return;
    let cancelled = false;
    const isCurrent = (): boolean => {
      const current = useVaultStore.getState();
      return (
        !cancelled &&
        !current.isOpeningVault &&
        current.currentVault?.path === vaultPath &&
        current.vaultToken === vaultToken
      );
    };
    const tick = (): void => {
      if (isCurrent())
        void runInboxPass(vaultPath, { expectedVaultToken: vaultToken }).then(
          async (out) => {
            if (isCurrent() && out.error)
              notice.warn(STRINGS[useUIStore.getState().lang].ing_auto_failed, {
                sub: out.error,
              });
            if (isCurrent() && !out.busy && !out.error) {
              try {
                const organized = await runSessionPass(vaultPath);
                if (isCurrent() && organized?.errors.length)
                  notice.warn(
                    STRINGS[useUIStore.getState().lang].ing_auto_failed,
                  );
              } catch (error) {
                if (isCurrent())
                  notice.warn(
                    STRINGS[useUIStore.getState().lang].ing_auto_failed,
                    { sub: String(error) },
                  );
              }
            }
          },
        );
    };
    // A short kick after enabling, then on the interval.
    const kick = window.setTimeout(tick, 4000);
    const id = window.setInterval(tick, intervalMin * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(id);
    };
  }, [enabled, intervalMin, vaultPath, vaultToken]);
}
