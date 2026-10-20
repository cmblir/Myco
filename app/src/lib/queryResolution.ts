// Later-state evidence retains its own cutoff, original lineage and scope.
import type { ActivityAdditionalSource, ActivityResolutionRequest, ActivitySynthesisReceipt, AgentVaultSession, AskScope } from "./ipc";
import { sourceTier } from "./extractive";
import { queryDateRange, type DateRange } from "./timeQuery";

/** Freeze an inclusive cutoff from the same clock used for question routing. */
export function activityResolution(range: DateRange, queryTime: Date, mode: ActivityResolutionRequest["mode"]): ActivityResolutionRequest {
  const capturedQueryEpoch = Math.floor(queryTime.getTime() / 1000);
  const { startEpoch, endEpoch } = queryDateRange(range);
  const asOfEpoch = mode === "current_state" ? capturedQueryEpoch : Math.min(endEpoch - 1, capturedQueryEpoch);
  if (!Number.isSafeInteger(capturedQueryEpoch) || capturedQueryEpoch < 0 || asOfEpoch < startEpoch)
    throw new Error("activity resolution query time is invalid");
  return { mode, asOfEpoch, capturedQueryEpoch };
}

interface ResolutionOptions {
  range?: DateRange;
  resolution?: ActivityResolutionRequest;
  origin?: AgentVaultSession;
  scope: AskScope;
  paths?: string[];
}

const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const hash = (value: string): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const controls = (value: string): boolean => [...value].some(char => {
  const code = char.charCodeAt(0);
  return code < 32 || (code >= 127 && code <= 159);
});
const path = (value: string): boolean => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  !controls(value) && !["\\", "[", "]", "|"].some(char => value.includes(char)) &&
  value.split("/").every(part => part !== "" && part !== "." && part !== "..");
const metadata = (value: string | null, limit: number): boolean => value === null ||
  (typeof value === "string" && [...value].length <= limit && !controls(value));

function keeps(scope: AskScope, page: string): boolean {
  const tier = sourceTier(page);
  if (scope === "sessions") return tier === "session";
  if (scope === "wiki") return tier !== "session" && tier !== "source";
  return !page.startsWith("raw/") || page.startsWith("raw/conversations/");
}

/** Validate app declarations before widening the citation list beyond initial hits. */
export function checkedResolutionSources(receipt: ActivitySynthesisReceipt, options: ResolutionOptions): ActivityAdditionalSource[] | null {
  const { resolution, range, origin, scope, paths } = options;
  if (!resolution) return receipt.resolutionWindow === null &&
    (receipt.resolutionCoverage == null) && !(receipt.additionalSources?.length) ? [] : null;
  if (!range || !origin) return null;
  const bounds = queryDateRange(range);
  const window = receipt.resolutionWindow;
  const expected = resolution.mode === "current_state" ? resolution.capturedQueryEpoch :
    Math.min(bounds.endEpoch - 1, resolution.capturedQueryEpoch);
  if (!window || ![resolution.capturedQueryEpoch, resolution.asOfEpoch].every(count) ||
      resolution.asOfEpoch < bounds.startEpoch || resolution.asOfEpoch !== expected ||
      window.mode !== resolution.mode || window.asOfEpoch !== resolution.asOfEpoch ||
      window.capturedQueryEpoch !== resolution.capturedQueryEpoch ||
      window.startEpoch !== bounds.startEpoch || window.endEpoch !== resolution.asOfEpoch + 1 ||
      receipt.activityPeriod.startEpoch !== bounds.startEpoch || receipt.activityPeriod.endEpoch !== bounds.endEpoch) return null;
  const coverage = receipt.resolutionCoverage;
  const declarations = receipt.additionalSources;
  const boundedWindows = coverage ? coverage.processedWindows + coverage.omittedWindows : 0;
  if (!coverage || !Array.isArray(declarations) || declarations.length > 12 ||
      ![coverage.candidateChunks, coverage.scannedPages, coverage.admittedPages, coverage.originalSpans,
        coverage.processedWindows, coverage.omittedWindows, coverage.excludedAfterAsOfSpans,
        coverage.undatedSpans, coverage.readBytes].every(count) ||
      !count(boundedWindows) || boundedWindows > 512 ||
      !count(receipt.boundedWindows) || receipt.boundedWindows > 512 || boundedWindows > receipt.boundedWindows ||
      !count(receipt.answerOriginalSpans) || receipt.answerOriginalSpans <= 0 || receipt.answerOriginalSpans > receipt.boundedWindows ||
      coverage.candidateChunks > 48 || coverage.scannedPages > 12 || coverage.admittedPages > coverage.scannedPages || coverage.originalSpans > 12 ||
      coverage.readBytes > 2 * 1024 * 1024 || typeof coverage.incomplete !== "boolean" ||
      !Array.isArray(coverage.issues) || coverage.issues.length > 64 ||
      coverage.issues.some(issue => !issue || !path(issue.citationPage) || !keeps(scope, issue.citationPage) ||
        (paths && !paths.includes(issue.citationPage)) ||
        !["source_unavailable", "read_budget", "index_stale", "original_proof_unavailable", "record_time_uncertain"].includes(issue.code)) ||
      declarations.length > coverage.admittedPages ||
      ((!coverage.incomplete) && (coverage.issues.length > 0 || coverage.omittedWindows > 0 || coverage.undatedSpans > 0))) return null;
  const pages = new Set<string>();
  let totalSpans = 0;
  for (const declaration of declarations) {
    if (!declaration || !path(declaration.citationPage) || pages.has(declaration.citationPage) ||
        !hash(declaration.citationRevision) || declaration.scope !== scope || !keeps(scope, declaration.citationPage) ||
        (paths && !paths.includes(declaration.citationPage)) ||
        declaration.origin?.vaultPath !== origin.vaultPath || declaration.origin.openingToken !== origin.openingToken ||
        !metadata(declaration.title, 256) || !metadata(declaration.stem, 256) || !declaration.stem ||
        !Array.isArray(declaration.lineage) || !declaration.lineage.length || declaration.lineage.length > 64) return null;
    pages.add(declaration.citationPage);
    const originals = new Set<string>();
    for (const original of declaration.lineage) {
      if (!original || !path(original.sourcePath) || !hash(original.sourceRevision) ||
          originals.has(original.sourcePath) || !Array.isArray(original.spans) || !original.spans.length || original.spans.length > 512) return null;
      originals.add(original.sourcePath);
      const spanIds = new Set<string>();
      for (const span of original.spans) {
        if (!span || typeof span.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(span.id) || spanIds.has(span.id) ||
            !count(span.start) || !count(span.end) || span.end <= span.start || span.end > 2 * 1024 * 1024 || !hash(span.sha256) ||
            !["user", "assistant", "tool", "system", "source", "unknown"].includes(span.speaker) ||
            !metadata(span.turnTime, 128) || !metadata(span.recordTime, 128) || !metadata(span.sourcePhase, 64)) return null;
        spanIds.add(span.id);
        totalSpans++;
      }
    }
  }
  return totalSpans <= boundedWindows && totalSpans <= receipt.answerOriginalSpans && totalSpans <= 512 ? declarations : null;
}
