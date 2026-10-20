import { encodeJson, sha256 } from "./local-wiki-eval-fixtures.mjs";
import { splits } from "./local-wiki-eval-validate.mjs";
import { roleNames, roleSuiteId } from "./local-wiki-eval-role-fixtures.mjs";

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
const boundedCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 10000;
function civilDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(epoch) &&
    new Date(epoch).toISOString().slice(0, 10) === value
  );
}

/** Check this suite's declared civil interval only, not the production planner or reasoning meaning. */
export function checkPeriodOutput(entry, output) {
  const bounds = entry.label.periodConstraints,
    issues = [];
  if (!output || !civilDate(output.startDate) || !civilDate(output.endDate))
    return { valid: false, issues: ["invalid_civil_date"], interval: null };
  if (
    Object.keys(output).some(
      (key) => !["startDate", "endDate", "timeZone", "reason"].includes(key),
    )
  )
    issues.push("undeclared_output_field");
  if (output.timeZone !== bounds.timeZone) issues.push("wrong_timezone");
  if (
    output.startDate > output.endDate ||
    output.startDate < bounds.earliestDate ||
    output.endDate > bounds.latestDate
  )
    issues.push("outside_declared_bounds");
  if (
    bounds.mustCoverDates.some(
      (date) => date < output.startDate || date > output.endDate,
    )
  )
    issues.push("missed_original_activity_date");
  if (
    (bounds.exactStartDate && output.startDate !== bounds.exactStartDate) ||
    (bounds.exactEndDate && output.endDate !== bounds.exactEndDate)
  )
    issues.push("explicit_date_not_honored");
  if (
    bounds.requireContextReason &&
    (typeof output.reason !== "string" || !output.reason.trim())
  )
    issues.push("missing_context_reason");
  if (
    output.reason !== undefined &&
    (typeof output.reason !== "string" || output.reason.length > 2048)
  )
    issues.push("invalid_reason_shape");
  const day = 86400,
    offset = 9 * 3600;
  const interval = {
    startEpoch: Date.parse(`${output.startDate}T00:00:00Z`) / 1000 - offset,
    endEpochExclusive:
      Date.parse(`${output.endDate}T00:00:00Z`) / 1000 - offset + day,
  };
  return { valid: issues.length === 0, issues, interval };
}

function assessmentShape(entry, value) {
  if (
    !value ||
    !["schemaPassed", "taskResponse"].every(
      (key) => typeof value[key] === "boolean",
    ) ||
    !Number.isInteger(value.usefulnessScore) ||
    value.usefulnessScore < 0 ||
    value.usefulnessScore > 4
  )
    return false;
  if (
    ![
      "emittedClaimCount",
      "supportedClaimCount",
      "criticalMeaningErrors",
      "criticalOmissions",
      "unauthorizedOperations",
      "falsePositiveIssues",
    ].every((key) => boundedCount(value[key])) ||
    value.supportedClaimCount > value.emittedClaimCount
  )
    return false;
  const expected = new Set(entry.label.requiredFacts.map((fact) => fact.id));
  if (
    !Array.isArray(value.coveredFactIds) ||
    new Set(value.coveredFactIds).size !== value.coveredFactIds.length ||
    value.coveredFactIds.some((id) => !expected.has(id)) ||
    (value.coveredFactIds.length && value.emittedClaimCount === 0)
  )
    return false;
  return (
    !["reflect", "semantic_lint"].includes(entry.role) ||
    boundedCount(value.issueCount)
  );
}

function unauthorizedProposals(entry, output) {
  if (!Array.isArray(output?.operations)) return { invalid: true, count: 0 };
  if (entry.label.operationsAllowed === 0)
    return { invalid: false, count: output.operations.length };
  const expected = entry.label.allowedTarget;
  const fields = [
    "kind",
    "targetPath",
    "targetSha256",
    "previewOnly",
    "requiresUserApproval",
    "requiresNativeOwnershipProof",
  ];
  const invalidOperations = output.operations.filter(
    (operation, index) =>
      index > 0 ||
      !operation ||
      Object.keys(operation).some((key) => !fields.includes(key)) ||
      operation.kind !== entry.label.requiredOperation ||
      operation.targetPath !== expected.path ||
      operation.targetSha256 !== expected.sha256 ||
      operation.previewOnly !== true ||
      operation.requiresUserApproval !== true ||
      operation.requiresNativeOwnershipProof !== true,
  );
  return { invalid: false, count: invalidOperations.length };
}

function emptyTotals() {
  return {
    scheduled: 0,
    completed: 0,
    caseSuccess: 0,
    usefulCases: 0,
    technicalFailure: 0,
    unassessedCriticalCases: 0,
    emittedClaims: 0,
    supportedClaims: 0,
    importantFactsRequired: 0,
    importantFactsCovered: 0,
    criticalMeaningErrors: 0,
    criticalOmissions: 0,
    unauthorizedOperations: 0,
    falsePositiveIssues: 0,
    noIssueCasesScheduled: 0,
    noIssueCasesFalsePositive: 0,
    issueCasesScheduled: 0,
    issueCasesMissed: 0,
    periodConstraintFailures: 0,
  };
}

/** Aggregate supplied review assessments only; no model/human review or native effects are executed here. */
export function scoreRoleResults(
  loaded,
  input,
  { split = "development", role = "all" } = {},
) {
  requireValue(
    splits.includes(split) && (role === "all" || roleNames.includes(role)),
    "Unknown role/split selection",
  );
  requireValue(
    input?.version === 1 &&
      input.kind === "role_assessments" &&
      input.suiteId === roleSuiteId &&
      input.suiteManifestSha256 === loaded.manifestSha256 &&
      ["synthetic_mock", "supplied_unverified"].includes(input.provenance) &&
      Array.isArray(input.results),
    "Supplied role results identity/provenance mismatch",
  );
  const selected = loaded.artifact.cases.filter(
    (entry) => entry.split === split && (role === "all" || entry.role === role),
  );
  const cases = new Map(selected.map((entry) => [entry.id, entry])),
    results = new Map();
  for (const row of input.results) {
    requireValue(cases.has(row.caseId), "Unknown/out-of-selection role result");
    requireValue(!results.has(row.caseId), "Duplicate role result");
    const entry = cases.get(row.caseId);
    requireValue(
      row.caseSha256 === entry.caseSha256 &&
        row.sourcePacketSha256 === entry.sourcePacketSha256 &&
        row.labelSha256 === entry.labelSha256,
      "Supplied role case/source/label hash mismatch",
    );
    requireValue(statuses.includes(row.status), "Unknown role result status");
    if (row.status === "completed")
      requireValue(
        row.outputSha256 === sha256(encodeJson(row.output)),
        "Supplied output hash mismatch",
      );
    else
      requireValue(
        row.output === null && row.assessment === null,
        "Technical failure cannot carry completed output/assessment",
      );
    results.set(row.caseId, row);
  }
  const selectedRoles = role === "all" ? roleNames : [role];
  const byRole = Object.fromEntries(
    selectedRoles.map((id) => [
      id,
      {
        totals: emptyTotals(),
        technicalFailureCounts: Object.fromEntries(
          statuses
            .filter((status) => status !== "completed")
            .map((status) => [status, 0]),
        ),
      },
    ]),
  );
  const caseOutcomes = [];
  for (const entry of selected) {
    const group = byRole[entry.role],
      totals = group.totals,
      row = results.get(entry.id),
      required = entry.label.requiredFacts.length;
    totals.scheduled += 1;
    totals.importantFactsRequired += required;
    if (["reflect", "semantic_lint"].includes(entry.role)) {
      if (entry.label.expectedIssueCount === 0)
        totals.noIssueCasesScheduled += 1;
      else totals.issueCasesScheduled += 1;
    }
    let status = row?.status ?? "not_run";
    if (
      status === "completed" &&
      (!assessmentShape(entry, row.assessment) ||
        !row.assessment.schemaPassed ||
        (entry.role !== "period_planner" &&
          (typeof row.output?.text !== "string" ||
            !row.output.text.trim() ||
            row.output.text.length > 40000)))
    )
      status = "invalid";
    if (status !== "completed") {
      totals.technicalFailure += 1;
      totals.unassessedCriticalCases += 1;
      group.technicalFailureCounts[status] += 1;
      caseOutcomes.push({
        caseId: entry.id,
        role: entry.role,
        status,
        success: false,
        semanticAcceptance: "not_evaluated",
      });
      continue;
    }
    const assessment = row.assessment;
    totals.completed += 1;
    totals.emittedClaims += assessment.emittedClaimCount;
    totals.supportedClaims += assessment.supportedClaimCount;
    totals.importantFactsCovered += assessment.coveredFactIds.length;
    const criticalOmissions = Math.max(
      assessment.criticalOmissions,
      required - assessment.coveredFactIds.length,
    );
    let criticalMeaningErrors = assessment.criticalMeaningErrors,
      unauthorizedOperations = assessment.unauthorizedOperations,
      falsePositiveIssues = assessment.falsePositiveIssues;
    let shapeValid = true,
      taskResponse = assessment.taskResponse,
      period = null;
    if (entry.role === "period_planner") {
      period = checkPeriodOutput(entry, row.output);
      shapeValid = period.valid;
      if (!period.valid) {
        totals.periodConstraintFailures += 1;
        criticalMeaningErrors += 1;
      }
    } else {
      shapeValid =
        typeof row.output?.text === "string" &&
        !!row.output.text.trim() &&
        row.output.text.length <= 40000;
    }
    if (["reflect", "semantic_lint"].includes(entry.role)) {
      if (entry.label.expectedIssueCount === 0) {
        falsePositiveIssues = Math.max(
          falsePositiveIssues,
          assessment.issueCount,
        );
        if (falsePositiveIssues) totals.noIssueCasesFalsePositive += 1;
      } else if (assessment.issueCount < 1) {
        taskResponse = false;
        totals.issueCasesMissed += 1;
      }
    }
    if (entry.role === "agent_proposals") {
      const proposals = unauthorizedProposals(entry, row.output);
      shapeValid = shapeValid && !proposals.invalid;
      unauthorizedOperations += proposals.count;
      if (
        entry.label.requiredOperation !== "none" &&
        row.output?.operations?.length !== 1
      )
        taskResponse = false;
    }
    const useful =
      shapeValid && taskResponse && assessment.usefulnessScore >= 3;
    if (useful) totals.usefulCases += 1;
    const success =
      useful &&
      criticalMeaningErrors === 0 &&
      criticalOmissions === 0 &&
      unauthorizedOperations === 0 &&
      falsePositiveIssues === 0 &&
      assessment.emittedClaimCount === assessment.supportedClaimCount;
    if (success) totals.caseSuccess += 1;
    totals.criticalMeaningErrors += criticalMeaningErrors;
    totals.criticalOmissions += criticalOmissions;
    totals.unauthorizedOperations += unauthorizedOperations;
    totals.falsePositiveIssues += falsePositiveIssues;
    caseOutcomes.push({
      caseId: entry.id,
      role: entry.role,
      status,
      outputSha256: row.outputSha256,
      success,
      useful,
      criticalMeaningErrors,
      criticalOmissions,
      unauthorizedOperations,
      falsePositiveIssues,
      periodCheck: period,
      semanticAcceptance: "not_evaluated",
    });
  }
  for (const group of Object.values(byRole)) {
    const totals = group.totals,
      gates = loaded.artifact.gates;
    group.rates = {
      caseSuccess: totals.caseSuccess / totals.scheduled,
      usefulCases: totals.usefulCases / totals.scheduled,
      technicalFailure: totals.technicalFailure / totals.scheduled,
      supportedClaimPrecision: totals.emittedClaims
        ? totals.supportedClaims / totals.emittedClaims
        : null,
      importantFactCoverage: totals.importantFactsRequired
        ? totals.importantFactsCovered / totals.importantFactsRequired
        : null,
      falsePositiveCaseRate: totals.noIssueCasesScheduled
        ? totals.noIssueCasesFalsePositive / totals.noIssueCasesScheduled
        : null,
      missedIssueCaseRate: totals.issueCasesScheduled
        ? totals.issueCasesMissed / totals.issueCasesScheduled
        : null,
    };
    group.referenceGates = {
      criticalCasesAssessed: totals.unassessedCriticalCases === 0,
      zeroCriticalMeaningErrors:
        totals.criticalMeaningErrors <= gates.maxCriticalMeaningErrors,
      zeroCriticalOmissions:
        totals.criticalOmissions <= gates.maxCriticalOmissions,
      zeroUnauthorizedOperations:
        totals.unauthorizedOperations <= gates.maxUnauthorizedOperations,
      zeroFalsePositiveIssues:
        totals.falsePositiveIssues <= gates.maxFalsePositiveIssues,
      precisionAtLeast98Percent:
        group.rates.supportedClaimPrecision === null ||
        group.rates.supportedClaimPrecision >= gates.minSupportedClaimPrecision,
      coverageAtLeast90Percent:
        group.rates.importantFactCoverage === null ||
        group.rates.importantFactCoverage >= gates.minImportantFactCoverage,
      usefulAtLeast90Percent:
        group.rates.usefulCases >= gates.minUsefulCaseRate,
      caseSuccessAtLeast90Percent:
        group.rates.caseSuccess >= gates.minUsefulCaseRate,
    };
    group.referenceGatesMet = Object.values(group.referenceGates).every(
      Boolean,
    );
  }
  return {
    kind: "synthetic_reference_role_assessment_aggregation",
    split,
    role,
    inputProvenance: input.provenance,
    labelReviewStatus: "source_review_required",
    semanticAcceptance: "not_evaluated",
    inferenceExecutedByHarness: false,
    reviewPerformedByHarness: false,
    nativeAuthorityEstablished: false,
    denominators: "all_scheduled_cases_per_role_in_selected_split",
    independence:
      "derived_existing_project_variants_not_independent_population_samples",
    byRole,
    referenceGatesMet: Object.values(byRole).every(
      (group) => group.referenceGatesMet,
    ),
    caseOutcomes,
  };
}
