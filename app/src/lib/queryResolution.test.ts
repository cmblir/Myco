import { describe, expect, it } from "vitest";
import { activityResolution, checkedResolutionSources } from "./queryResolution";
import type { ActivitySynthesisReceipt } from "./ipc";
import { queryDateRange } from "./timeQuery";

describe("activity resolution query snapshot", () => {
  const range = { start: "2026-10-01", end: "2026-10-04" };
  const queryTime = new Date("2026-10-07T12:00:00.987Z");

  it("limits historical answers to their declared period even when asked later", () => {
    expect(activityResolution(range, queryTime, "historical_as_of")).toEqual({
      mode: "historical_as_of", asOfEpoch: queryDateRange(range).endEpoch - 1,
      capturedQueryEpoch: Math.floor(queryTime.getTime() / 1000),
    });
  });

  it("allows current-state advice to inspect later original records through query time", () => {
    expect(activityResolution(range, queryTime, "current_state")).toEqual({
      mode: "current_state", asOfEpoch: Math.floor(queryTime.getTime() / 1000),
      capturedQueryEpoch: Math.floor(queryTime.getTime() / 1000),
    });
  });

  it("excludes the unobserved remainder of the current day", () => {
    const current = { start: "2026-10-01", end: "2026-10-07" };
    expect(activityResolution(current, queryTime, "historical_as_of").asOfEpoch)
      .toBe(Math.floor(queryTime.getTime() / 1000));
  });

  it.each([new Date("invalid"), new Date("2026-09-30T00:00:00Z")])(
    "rejects an invalid or earlier query snapshot %s", query => {
      expect(() => activityResolution(range, query, "current_state")).toThrow("query time is invalid");
    },
  );
});

describe("later-source retained window closure", () => {
  const range = { start: "2026-10-01", end: "2026-10-04" };
  const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
  const resolution = activityResolution(range, new Date("2026-10-07T12:00:00Z"), "current_state");
  const bounds = queryDateRange(range);

  function receipt(): ActivitySynthesisReceipt {
    return {
      activityPeriod: { ...bounds }, scope: "wiki",
      eligibleOriginalSpans: 2, boundedWindows: 3, processedWindows: 2, omittedWindows: 1,
      originalPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 1, uncertainSpans: 0 },
      extractionBatches: 1, proposedClaims: 1, selectedClaims: 1, omittedClaims: 0, answerOriginalSpans: 3,
      answerPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 2, uncertainSpans: 0 },
      claimSourceAndStructureChecked: true, semanticReviewRequired: true, independentVerificationReceipts: 0,
      automatedClaimReviews: 1, automatedAnswerReviewInputRevision: "a".repeat(64), originalInputsIncomplete: false,
      resolutionWindow: { ...resolution, startEpoch: bounds.startEpoch, endEpoch: resolution.asOfEpoch + 1 },
      resolutionCoverage: { candidateChunks: 1, scannedPages: 1, admittedPages: 1, originalSpans: 1,
        processedWindows: 1, omittedWindows: 1, excludedAfterAsOfSpans: 0, undatedSpans: 0,
        readBytes: 48, incomplete: true, issues: [] },
      additionalSources: [{ citationPage: "wiki/synthetic-later.md", citationRevision: "b".repeat(64),
        title: "Synthetic withdrawal", stem: "synthetic-later", origin, scope: "wiki",
        lineage: [{ sourcePath: "raw/synthetic-later.md", sourceRevision: "c".repeat(64),
          spans: [0, 24].map((start, index) => ({ id: `later-${index + 1}`, start, end: start + 24,
            sha256: "d".repeat(64), speaker: "user", turnTime: "2026-10-06T12:00:00Z",
            recordTime: null, sourcePhase: null })) }] }],
    };
  }

  it("accepts later original lineage including a retained unprocessed contrary window", () => {
    const native = receipt();
    expect(checkedResolutionSources(native, { range, resolution, origin, scope: "wiki" }))
      .toEqual(native.additionalSources);
  });

  it.each(["lineage_exceeds_windows", "complete_with_omission", "window_overflow", "unsafe_window_sum",
    "negative_omission", "fractional_window", "answer_overflow", "answer_exceeds_windows"] as const)(
    "rejects retained-lineage declarations with invalid context coverage: %s", field => {
      const native = receipt();
      const coverage = native.resolutionCoverage!;
      if (field === "lineage_exceeds_windows") coverage.omittedWindows = 0;
      if (field === "complete_with_omission") coverage.incomplete = false;
      if (field === "window_overflow") {
        coverage.omittedWindows = 512;
        native.boundedWindows = 514;
      }
      if (field === "unsafe_window_sum") coverage.omittedWindows = Number.MAX_SAFE_INTEGER;
      if (field === "negative_omission") coverage.omittedWindows = -1;
      if (field === "fractional_window") coverage.processedWindows = 1.5;
      if (field === "answer_overflow") native.answerOriginalSpans = 513;
      if (field === "answer_exceeds_windows") native.answerOriginalSpans = 4;
      expect(checkedResolutionSources(native, { range, resolution, origin, scope: "wiki" })).toBeNull();
    },
  );
});
