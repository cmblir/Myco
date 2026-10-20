import { splits } from "./local-wiki-eval-validate.mjs";
import { reviewId, reviewStatus } from "./local-wiki-eval-review-fixtures.mjs";

const statuses = [
  "completed",
  "unavailable",
  "stopped",
  "cancelled",
  "invalid",
  "failed",
  "not_run",
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** Aggregate supplied verdicts against frozen synthetic references; never issue semantic acceptance. */
export function scoreReviewResults(loaded, input, split = "development") {
  requireValue(splits.includes(split), "Unknown review split");
  requireValue(!loaded.bundle || loaded.bundle.split === split, "Results split differs from the frozen bundle");
  requireValue(
    input?.version === 1 &&
      input.kind === "review_verdicts" &&
      input.suiteId === reviewId &&
      input.suiteManifestSha256 === loaded.manifestSha256,
    "Review results suite identity mismatch",
  );
  requireValue(
    ["synthetic_mock", "supplied_unverified"].includes(input.provenance) &&
      Array.isArray(input.results),
    "Results must declare unverified or synthetic provenance",
  );
  const selectedPairs = loaded.artifact.pairs.filter(
    (pair) => pair.split === split,
  );
  const scheduled = new Map(
    selectedPairs.flatMap((pair) =>
      pair.cases.map((entry) => [entry.id, { pair, entry }]),
    ),
  );
  const results = new Map();
  for (const row of input.results) {
    requireValue(
      scheduled.has(row.caseId),
      "Unknown or out-of-split review result",
    );
    requireValue(!results.has(row.caseId), "Duplicate review result");
    const { pair, entry } = scheduled.get(row.caseId);
    requireValue(
      row.sourceSha256 === pair.source.sha256 &&
        row.originalSpanSha256 === pair.originalSpan.sha256 &&
        row.proposalSha256 === entry.proposalSha256 &&
        row.claimSha256 === entry.claimSha256,
      "Supplied review result source/claim identity mismatch",
    );
    requireValue(statuses.includes(row.status), "Unknown review result status");
    requireValue(
      row.status === "completed" || row.verdict === null,
      "Technical failure cannot carry a successful verdict",
    );
    const validVerdict = ["accept", "reject"].includes(row.verdict);
    results.set(row.caseId, {
      status:
        row.status === "completed" && !validVerdict ? "invalid" : row.status,
      verdict: row.status === "completed" && validVerdict ? row.verdict : null,
    });
  }
  const caseOutcomes = [];
  const totals = {
    scheduled: scheduled.size,
    correctProposals: selectedPairs.length,
    incorrectProposals: selectedPairs.length,
    completed: 0,
    correctAccepted: 0,
    incorrectRejected: 0,
    falseAcceptance: 0,
    falseRejection: 0,
    caseSuccess: 0,
    technicalFailure: 0,
  };
  const technicalFailureCounts = Object.fromEntries(
    statuses
      .filter((status) => status !== "completed")
      .map((status) => [status, 0]),
  );
  const mutationCounts = Object.fromEntries(
    ["actor", "action", "eventTime", "status"].map((kind) => [
      kind,
      {
        scheduledPairs: 0,
        falseAcceptance: 0,
        falseRejection: 0,
        technicalFailure: 0,
        pairedSuccess: 0,
      },
    ]),
  );
  const pairOutcomes = [];
  for (const pair of selectedPairs) {
    const outcomes = pair.cases.map((entry) => {
      const result = results.get(entry.id) ?? {
        status: "not_run",
        verdict: null,
      };
      const isCorrectProposal = entry.variant === "source_supported";
      const success =
        result.status === "completed" &&
        result.verdict === entry.label.expectedVerdict;
      if (result.status === "completed") {
        totals.completed += 1;
        if (isCorrectProposal && result.verdict === "accept")
          totals.correctAccepted += 1;
        if (!isCorrectProposal && result.verdict === "reject")
          totals.incorrectRejected += 1;
        if (isCorrectProposal && result.verdict === "reject") {
          totals.falseRejection += 1;
          mutationCounts[pair.mutationKind].falseRejection += 1;
        }
        if (!isCorrectProposal && result.verdict === "accept") {
          totals.falseAcceptance += 1;
          mutationCounts[pair.mutationKind].falseAcceptance += 1;
        }
      } else {
        totals.technicalFailure += 1;
        technicalFailureCounts[result.status] += 1;
        mutationCounts[pair.mutationKind].technicalFailure += 1;
      }
      if (success) totals.caseSuccess += 1;
      const outcome = {
        caseId: entry.id,
        pairId: pair.id,
        expectedVerdict: entry.label.expectedVerdict,
        labelSha256: entry.labelSha256,
        proposalSha256: entry.proposalSha256,
        ...result,
        success,
      };
      caseOutcomes.push(outcome);
      return outcome;
    });
    const pairSuccess = outcomes.every((outcome) => outcome.success);
    mutationCounts[pair.mutationKind].scheduledPairs += 1;
    if (pairSuccess) mutationCounts[pair.mutationKind].pairedSuccess += 1;
    pairOutcomes.push({
      pairId: pair.id,
      success: pairSuccess,
      falseAcceptance: outcomes.some(
        (outcome) =>
          outcome.expectedVerdict === "reject" && outcome.verdict === "accept",
      ),
      falseRejection: outcomes.some(
        (outcome) =>
          outcome.expectedVerdict === "accept" && outcome.verdict === "reject",
      ),
      technicalFailure: outcomes.some(
        (outcome) => outcome.status !== "completed",
      ),
    });
  }
  const rates = {
    falseAcceptance: totals.falseAcceptance / totals.incorrectProposals,
    falseRejection: totals.falseRejection / totals.correctProposals,
    correctProposalAcceptance: totals.correctAccepted / totals.correctProposals,
    caseSuccess: totals.caseSuccess / totals.scheduled,
    technicalFailure: totals.technicalFailure / totals.scheduled,
    pairedSuccess:
      pairOutcomes.filter((pair) => pair.success).length / selectedPairs.length,
  };
  const incorrectVerdictsComplete = caseOutcomes
    .filter((outcome) => outcome.expectedVerdict === "reject")
    .every((outcome) => outcome.status === "completed");
  const referenceGates = {
    zeroCriticalWrongMeaningAcceptance:
      totals.falseAcceptance ===
      loaded.artifact.gates.maxCriticalWrongMeaningAcceptance,
    correctProposalAcceptanceAtLeast90Percent:
      rates.correctProposalAcceptance >=
      loaded.artifact.gates.minCorrectProposalAcceptance,
    incorrectVerdictsComplete,
  };
  return {
    kind: "synthetic_reference_verdict_aggregation",
    split,
    inputProvenance: input.provenance,
    labelReviewStatus: reviewStatus,
    semanticAcceptance: "not_evaluated",
    inferenceExecutedByHarness: false,
    denominators: "all_scheduled_cases_in_selected_split",
    independence:
      "paired_existing_project_variants_not_independent_population_samples",
    totals,
    rates,
    technicalFailureCounts,
    mutationCounts,
    pairedCounts: {
      scheduled: selectedPairs.length,
      success: pairOutcomes.filter((pair) => pair.success).length,
      falseAcceptance: pairOutcomes.filter((pair) => pair.falseAcceptance)
        .length,
      falseRejection: pairOutcomes.filter((pair) => pair.falseRejection).length,
      technicalFailure: pairOutcomes.filter((pair) => pair.technicalFailure)
        .length,
    },
    referenceGates,
    referenceGatesMet: Object.values(referenceGates).every(Boolean),
    pairOutcomes,
    caseOutcomes,
  };
}
