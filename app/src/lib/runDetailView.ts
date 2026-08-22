// Pure shaping for the run drill-in on PageHistory (W3–6 item 6): RunDetail +
// FileDiff[] → render rows. `diffs === null` is the no-commit fallback — the
// run has no git commit, so rows come from the manifest file list instead.
import type { FileDiff, RunDetail } from "./ipc";
import { diffLines, type DiffLine } from "./wordDiff";

export type RunStatusKey =
  | "history_status_added"
  | "history_status_modified"
  | "history_status_renamed"
  | "history_status_deleted";

export interface RunFileRow {
  rel: string;
  statusKey: RunStatusKey;
  /** null when there is nothing to render (manifest fallback, or too large). */
  diff: DiffLine[] | null;
  /** Both sides were over the Rust-side 256 KiB cap — show a note, no diff. */
  tooLarge: boolean;
}

export interface RunRows {
  files: RunFileRow[];
  /** True when the run has no git commit; `files` is the manifest list. */
  noCommit: boolean;
  /** WHY report path (vault-relative), present iff the report file exists. */
  whyRel: string | null;
}

const STATUS_KEYS: Record<string, RunStatusKey> = {
  added: "history_status_added",
  modified: "history_status_modified",
  renamed: "history_status_renamed",
  deleted: "history_status_deleted",
};

export function buildRunRows(detail: RunDetail, diffs: FileDiff[] | null): RunRows {
  if (diffs === null) {
    const row = (rel: string, statusKey: RunStatusKey): RunFileRow => ({
      rel,
      statusKey,
      diff: null,
      tooLarge: false,
    });
    return {
      files: [
        ...detail.moves.map(([from, to]) => row(`${from} → ${to}`, "history_status_renamed")),
        ...detail.trashed.map(([from]) => row(from, "history_status_deleted")),
        ...detail.created.map((rel) => row(rel, "history_status_added")),
      ],
      noCommit: true,
      whyRel: detail.report_rel,
    };
  }
  return {
    files: diffs.map((d) => {
      // Added files have after only, deleted before only, modified both — both
      // sides null happens exclusively when the Rust side capped the content.
      const tooLarge = d.before === null && d.after === null;
      return {
        rel: d.path,
        statusKey: STATUS_KEYS[d.status] ?? "history_status_modified",
        diff: tooLarge ? null : diffLines(d.before ?? "", d.after ?? ""),
        tooLarge,
      };
    }),
    noCommit: false,
    whyRel: detail.report_rel,
  };
}
