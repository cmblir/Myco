import { readGuidedQuestion, type GuidedQuestionSelection } from "./guidedQuestion";
import type { ContextPackingAudit } from "./modelContextBudget";
import type { DateRange } from "./timeQuery";

/** Small display metadata, kept separate from generated text and source bodies. */
export interface AskPackingCoverage {
  selectedPassages: number;
  omittedPassages: number;
  omittedOnIncludedPages: number;
}
export interface AskActivityCoverage {
  scannedPages: number; sources: number; incomplete: boolean;
}
export interface AskHistoricalCoverage {
  asOf: string; afterCutoff: number; dateUnverified: number;
}
export interface AskSearchContext {
  version: 1;
  guidedQuestion?: GuidedQuestionSelection;
  /** Counts observed while preparing delivered evidence, not whole-corpus totals. */
  historical?: AskHistoricalCoverage;
  range?: DateRange;
  rangeIgnored?: true;
  paths?: string[];
  packing?: AskPackingCoverage;
  activityCoverage?: AskActivityCoverage;
  activityQuestion?: string;
  periodClarification?: true;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const present = (value: unknown) => value !== undefined && value !== null;

/** Optional bad metadata never erases the saved answer or invents coverage. */
export function readAskSearchContext(value: unknown): AskSearchContext | undefined {
  if (!object(value) || value.version !== 1) return undefined;
  const result: AskSearchContext = {version:1};
  if (present(value.guidedQuestion)) {
    const guided = readGuidedQuestion(value.guidedQuestion);
    if (guided) result.guidedQuestion = guided;
  }
  if (object(value.historical) && day(value.historical.asOf) && count(value.historical.afterCutoff) && count(value.historical.dateUnverified)) {
    result.historical = {asOf:value.historical.asOf,afterCutoff:value.historical.afterCutoff,dateUnverified:value.historical.dateUnverified};
  }
  if (present(value.range)) {
    if (!object(value.range) || !day(value.range.start) || !day(value.range.end) || value.range.start > value.range.end) return undefined;
    result.range = {start:value.range.start,end:value.range.end};
  }
  for (const key of ["rangeIgnored","periodClarification"] as const) {
    if (!present(value[key])) continue;
    if (value[key] !== true) return undefined;
    result[key] = true;
  }
  if (present(value.paths)) {
    if (!Array.isArray(value.paths) || !value.paths.every(path=>typeof path === "string")) return undefined;
    result.paths = [...value.paths];
  }
  if (present(value.packing)) {
    const p=value.packing;
    if (!object(p) || !count(p.selectedPassages) || !count(p.omittedPassages) || !count(p.omittedOnIncludedPages) ||
        p.omittedOnIncludedPages > p.omittedPassages) return undefined;
    result.packing = {selectedPassages:p.selectedPassages,omittedPassages:p.omittedPassages,omittedOnIncludedPages:p.omittedOnIncludedPages};
  }
  if (present(value.activityCoverage)) {
    const c=value.activityCoverage;
    if (!object(c) || !count(c.scannedPages) || !count(c.sources) || typeof c.incomplete !== "boolean") return undefined;
    result.activityCoverage = {scannedPages:c.scannedPages,sources:c.sources,incomplete:c.incomplete};
  }
  if (present(value.activityQuestion)) {
    if (typeof value.activityQuestion !== "string") return undefined;
    result.activityQuestion = value.activityQuestion;
  }
  return result;
}

/** Passage coverage cannot be inferred from the number of citation pages. */
export function packingCoverageOf(audit: ContextPackingAudit): AskPackingCoverage {
  const pages = new Set(audit.selected.map(p=>p.page.normalize("NFC")));
  return {selectedPassages:audit.selected.length,omittedPassages:audit.omitted.length,
    omittedOnIncludedPages:audit.omitted.filter(p=>pages.has(p.page.normalize("NFC"))).length};
}
