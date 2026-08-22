// One-line summary for a distill run row (Q4 item 3): relative time plus
// only the non-zero counts, e.g. "2 hours ago · → 3 · + 2".
import type { Lang } from "./i18n";
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
  return parts.join(" · ");
}
