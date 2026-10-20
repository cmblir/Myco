import { getValue, parseFrontmatter, patchFrontmatter, type FmPatch, type Frontmatter } from "./frontmatter";
import type { EvidenceChunk } from "./sessionEvidence";

function originalDay(value: unknown): string | undefined {
  if (typeof value === "number") {
    const parsed = new Date(value * 1_000);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : undefined;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return undefined;
  const day = value.slice(0, 10);
  const civil = new Date(`${day}T00:00:00Z`);
  const parsed = new Date(value);
  return Number.isFinite(civil.getTime()) && civil.toISOString().slice(0, 10) === day && Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10) : undefined;
}

function originalDates(fm: Frontmatter | null, source: string, chunks: readonly EvidenceChunk[]): FmPatch {
  if (!["work", "process", "empty"].includes(String(getValue(fm, "session_kind")))) return {};
  const imported = parseFrontmatter(source);
  const recordDays = [getValue(fm, "session_record_start"), getValue(fm, "session_record_end")];
  if (imported?.entries.filter(entry => entry.key === "created").length === 1) recordDays.push(getValue(imported, "created"));
  const records = recordDays.map(originalDay).filter((day): day is string => day !== undefined).sort();
  const previous = getValue(fm, "session_activity_days");
  // Only aligned explicit turn metadata supplies event dates. The evidence
  // renderer's fallback date must never make an old conversation look recent.
  const hasTurnMetadata = imported?.entries.filter(entry => entry.key === "turn_metadata").length === 1;
  const days = [...(Array.isArray(previous) ? previous : []), ...(hasTurnMetadata ? chunks.map(chunk => chunk.timestamp) : [])]
    .map(originalDay).filter((day): day is string => day !== undefined);
  return { ...(records.length ? { session_record_start: records[0], session_record_end: records.at(-1)! } : {}),
    session_activity_days: [...new Set(days)].sort() };
}

/** Refresh generated session metadata while retaining titles edited by a person. */
export function refreshSessionNote(raw: string, key: string, title: string, revision: string, date: string, isNew: boolean, source: string, chunks: readonly EvidenceChunk[]): string {
  const fm = parseFrontmatter(raw);
  const currentKey = getValue(fm, "session_key");
  if (currentKey !== undefined && currentKey !== key) throw new Error("session identity mismatch");
  const oldTitle = getValue(fm, "session_generated_title");
  const generatedTitle = `Source: ${title}`;
  const canUpdateTitle = isNew || (typeof oldTitle === "string" && getValue(fm, "title") === oldTitle);
  let next = patchFrontmatter(raw, { session_key: key, session_generated_title: generatedTitle,
    session_revision: revision, last_updated: date, ...originalDates(fm, source, chunks),
    ...(canUpdateTitle ? { title: generatedTitle } : {}) }).raw;
  if (canUpdateTitle) {
    const expectedHeading = isNew ? generatedTitle : oldTitle;
    next = next.replace(/^# ([^\n]*)$/m, (line, heading: string) => heading === expectedHeading ? `# ${generatedTitle}` : line);
  }
  return next;
}
