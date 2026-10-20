// Home's notices (spec 2026-10-02): the suspect scan, the run log and the
// contradictions behind the bell on Home and the sidebar's Home badge. One
// store so the two read one count (decision 4) and one fetch serves both.
//
// "While you were away" is measured from `since`: the visit stamp Home took
// over when it opened, moved on to this visit's stamp when Home closes — so
// what was shown on Home stops counting once the user leaves it, and the
// sidebar and the bell never disagree about it, on Home or off it.

import { useMemo } from "react";
import { create } from "zustand";
import {
  contradictionKey,
  findContradictions,
  loadIgnored,
  saveIgnored,
  type Contradiction,
} from "../lib/contradictions";
import { ipc, type RunDetail, type RunSummary, type SuspectReport } from "../lib/ipc";
import { buildNotices, NOTICE_ITEMS, runsSince, type HomeNotice } from "../lib/overviewReport";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";

interface NoticesState {
  /** Vault the data below belongs to. */
  vault: string | null;
  status: "idle" | "loading" | "ready" | "error";
  suspects: SuspectReport | null;
  runs: RunSummary[];
  details: Record<string, RunDetail>;
  since: number | null;
  /** Contradictions the user chose to ignore (contradictionKey). */
  ignored: ReadonlySet<string>;
  load: (vault: string) => Promise<void>;
  setSince: (at: number | null) => void;
  ignoreContradiction: (c: Contradiction) => void;
}

export const useNoticesStore = create<NoticesState>((set, get) => ({
  vault: null,
  status: "idle",
  suspects: null,
  runs: [],
  details: {},
  since: useUIStore.getState().lastVisitAt,
  ignored: loadIgnored(),

  async load(vault) {
    const prev = get();
    if (prev.vault === vault && prev.status === "loading") return;
    set(
      prev.vault === vault
        ? { status: "loading" }
        : { vault, status: "loading", suspects: null, runs: [], details: {} },
    );
    const [suspects, runs] = await Promise.allSettled([
      ipc.suspectPages(vault),
      ipc.listDistillRuns(vault, 20),
    ]);
    if (get().vault !== vault) return;
    const log = runs.status === "fulfilled" ? runs.value : get().runs;
    // Names for the changes notice: only the newest runs since the visit, and
    // a manifest read once is kept.
    const known = get().details;
    const wanted = runsSince(log, get().since)
      .slice(0, NOTICE_ITEMS)
      .filter((r) => !known[r.id]);
    const read = await Promise.all(
      wanted.map((r) => ipc.distillRunDetail(vault, r.id).catch(() => null)),
    );
    if (get().vault !== vault) return;
    const details = { ...known };
    for (const d of read) if (d) details[d.id] = d;
    // A failed refresh keeps what the last good one showed.
    set({
      suspects: suspects.status === "fulfilled" ? suspects.value : get().suspects,
      runs: log,
      details,
      status: suspects.status === "fulfilled" && runs.status === "fulfilled" ? "ready" : "error",
    });
  },

  setSince: (since) => set({ since }),

  ignoreContradiction(c) {
    const next = new Set(get().ignored);
    next.add(contradictionKey(c));
    saveIgnored(next);
    set({ ignored: next });
  },
}));

/** Contradictions in the open vault the user has not ignored — the Home
 *  panel's rows and the notice's count. */
export function useContradictions(): Contradiction[] {
  const vault = useVaultStore((s) => s.currentVault);
  const adjacency = useVaultStore((s) => s.adjacency);
  const ignored = useNoticesStore((s) => s.ignored);
  return useMemo(
    () =>
      vault && adjacency
        ? findContradictions(adjacency, vault.path).filter((c) => !ignored.has(contradictionKey(c)))
        : [],
    [vault, adjacency, ignored],
  );
}

/** What the bell lists and both badges count. */
export function useHomeNotices(): HomeNotice[] {
  const path = useVaultStore((s) => s.currentVault?.path ?? null);
  const contradictions = useContradictions().length;
  const vault = useNoticesStore((s) => s.vault);
  const suspects = useNoticesStore((s) => s.suspects);
  const runs = useNoticesStore((s) => s.runs);
  const details = useNoticesStore((s) => s.details);
  const since = useNoticesStore((s) => s.since);
  return useMemo(() => {
    // Another vault's scan never counts here.
    const mine = vault === path;
    return buildNotices({
      runs: mine ? runs : [],
      since,
      details,
      suspects: mine ? suspects : null,
      contradictions,
    });
  }, [path, vault, suspects, runs, details, since, contradictions]);
}
