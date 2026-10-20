// One-line summary for a distill run row (Q4 item 3): relative time plus
// only the non-zero counts, e.g. "2 hours ago · → 3 · + 2".
import { STRINGS, type Lang, type Strings } from "./i18n";
import type { RunSummary } from "./ipc";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export function formatRunLine(r: RunSummary, lang: Lang): string {
  const delta = Math.floor(Date.now() / 1000) - r.started_at;
  const [unit, secs] = UNITS.find(([, s]) => delta >= s) ?? ["minute", 60];
  const rel = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(
    -Math.max(1, Math.round(delta / secs)),
    unit,
  );
  const parts: string[] = [rel];
  if (r.moves > 0) parts.push(`→ ${r.moves}`);
  if (r.created > 0) parts.push(`+ ${r.created}`);
  if (r.trashed > 0) parts.push(`✕ ${r.trashed}`);
  if ((r.deleted ?? 0) > 0) parts.push(STRINGS[lang].deleted_count.replace("{n}", new Intl.NumberFormat(lang).format(r.deleted!)));
  return parts.join(" · ");
}

/** A run's name for people (S29): its kind, from the id's shape (`digest-`
 *  a session digest, `llm-` a model pass, a bare stamp Rust's own run),
 *  and when it started, in the app's language. */
export function runTitle(
  r: RunSummary,
  lang: Lang,
  t: Pick<Strings, "history_run_kind_digest" | "history_run_kind_llm" | "history_run_kind_distill">,
): string {
  const kind = r.id.startsWith("digest-")
    ? t.history_run_kind_digest
    : r.id.startsWith("llm-")
      ? t.history_run_kind_llm
      : t.history_run_kind_distill;
  const when = new Intl.DateTimeFormat(lang, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(r.started_at * 1000);
  return `${kind} · ${when}`;
}
