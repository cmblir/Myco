// Pure composition for Home's notices (spec 2026-10-02, decisions 2-4): what
// the bell counts and its popover lists. One builder feeds both the bell and
// the sidebar's Home badge, so the two numbers cannot drift apart.
import type { Lang, Strings } from "./i18n";
import type { RunDetail, RunSummary, SuspectPage, SuspectReport } from "./ipc";

export function topSuspects(r: SuspectReport, n: number): SuspectPage[] {
  return [...r.suspects].sort((a, b) => b.reasons.length - a.reasons.length).slice(0, n);
}

/** The first n pages to check as notice rows; Infinity is the bell's
 *  "see all" list. */
export function checkItems(r: SuspectReport, n: number): NoticeItem[] {
  // suspect_scan paths are relative to wiki/.
  return topSuspects(r, n).map((s) => ({ rel: `wiki/${s.page}`, reason: s.reasons[0] }));
}

/** How many named rows a notice shows before "see all". */
export const NOTICE_ITEMS = 3;

export interface NoticeItem {
  /** Vault-relative path; the row opens it. */
  rel: string;
  /** A page to check: its first problem, as the lint said it (plainCheckReason
   *  turns it into words at render time). */
  reason?: string;
}

export type HomeNotice =
  | { kind: "changes"; count: number; items: NoticeItem[] }
  | { kind: "check"; count: number; items: NoticeItem[] }
  | { kind: "contradictions"; count: number };

export interface NoticeInput {
  /** The run log, newest first (list_distill_runs). */
  runs: RunSummary[];
  /** Epoch ms of the Home visit the user is "away" from; null = never visited,
   *  so every run the log still holds counts. */
  since: number | null;
  /** Manifests of the runs since then, by run id — the changed notes' names. */
  details: Record<string, RunDetail>;
  suspects: SuspectReport | null;
  contradictions: number;
}

/** Runs that happened while the user was away. */
export function runsSince(runs: RunSummary[], since: number | null): RunSummary[] {
  return runs.filter((r) => since === null || r.started_at * 1000 > since);
}

/** A changed path a row can open: a note, never a raw/ original. */
const openable = (rel: string): boolean => rel.endsWith(".md") && !rel.startsWith("raw/");

/** Only kinds with something in them; "quiet" and "clean" are not notices. */
export function buildNotices(i: NoticeInput): HomeNotice[] {
  const out: HomeNotice[] = [];
  const away = runsSince(i.runs, i.since);
  const changed = away.reduce((n, r) => n + r.moves + r.created + r.trashed, 0);
  if (changed > 0) {
    const names = away.flatMap((r) => {
      const d = i.details[r.id];
      return d ? [...d.created, ...d.moves.map(([, to]) => to)] : [];
    });
    const items = [...new Set(names.filter(openable))]
      .slice(0, NOTICE_ITEMS)
      .map((rel) => ({ rel }));
    out.push({ kind: "changes", count: changed, items });
  }
  if (i.suspects && i.suspects.suspects.length > 0) {
    out.push({
      kind: "check",
      count: i.suspects.suspects.length,
      items: checkItems(i.suspects, NOTICE_ITEMS),
    });
  }
  if (i.contradictions > 0) out.push({ kind: "contradictions", count: i.contradictions });
  return out;
}

/** The badge on the bell AND on the sidebar's Home row — both render this one
 *  value, so the two cannot disagree (decision 4). One per notice row, so it
 *  counts what the popover lists, not every page behind a row: a hundred pages
 *  to check is one thing to look at, not a hundred. null = no badge. */
export function noticeBadge(
  notices: HomeNotice[],
  t: Strings,
  lang: Lang,
): { count: string; label: string } | null {
  if (notices.length === 0) return null;
  const count = new Intl.NumberFormat(lang).format(notices.length);
  return { count, label: t.hn_label_n.replace("{n}", count) };
}

// The start of every message mcp_native::lint_page and suspect_scan write
// (src-tauri/src/mcp_native.rs) → its plain line. Change the two together; a
// message missing here reads as chk_other, never as the raw lint text.
const CHECK_REASONS: [string, keyof Strings][] = [
  ["missing frontmatter", "chk_no_frontmatter"],
  ["missing `type`", "chk_no_type"],
  ["invalid `type`", "chk_bad_type"],
  ["status=superseded without", "chk_superseded"],
  ["status=disputed without", "chk_disputed"],
  ["citation [^", "chk_citation"],
  ["footnote [^", "chk_footnote"],
  ["source_count is not a number", "chk_source_count_nan"],
  ["source_count=", "chk_source_count"],
  ["confidence: declared", "chk_confidence"],
];

export function plainCheckReason(reason: string, t: Strings): string {
  const hit = CHECK_REASONS.find(([start]) => reason.startsWith(start));
  return t[hit ? hit[1] : "chk_other"] as string;
}
