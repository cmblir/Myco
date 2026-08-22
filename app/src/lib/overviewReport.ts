// Pure composition for the Morning-Report band (Q4 item 2).
import type { Lang, Strings } from "./i18n";
import type { SuspectPage, SuspectReport } from "./ipc";

export interface MorningInput {
  runsSince: number;
  pagesMoved: number;
  lang: Lang;
}

export function buildMorningHeadline(i: MorningInput, t: Strings): string {
  if (i.runsSince <= 0 && i.pagesMoved <= 0) {
    return t.ov_since_quiet ?? "All quiet since your last visit.";
  }
  return (t.ov_since_title ?? "{runs} distill runs, {pages} pages moved")
    .replace("{runs}", String(i.runsSince))
    .replace("{pages}", String(i.pagesMoved));
}

export function topSuspects(r: SuspectReport, n: number): SuspectPage[] {
  return [...r.suspects].sort((a, b) => b.reasons.length - a.reasons.length).slice(0, n);
}
