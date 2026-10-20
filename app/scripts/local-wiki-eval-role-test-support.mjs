import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { encodeJson, sha256 } from "./local-wiki-eval-fixtures.mjs";
import { roleSuiteId } from "./local-wiki-eval-role-fixtures.mjs";

export async function temporary(run) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "myco-role-fixtures-test-"),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function rehashCase(entry) {
  const {
    caseSha256: ignoredCaseHash,
    sourcePacketSha256: ignoredPacketHash,
    label,
    labelSha256: ignoredLabelHash,
    ...content
  } = entry;
  entry.caseSha256 = sha256(encodeJson(content));
  entry.sourcePacketSha256 = sha256(encodeJson(content.sourcePackets));
  entry.labelSha256 = sha256(encodeJson(label));
}

export function referenceAssessments(
  loaded,
  { split = "development", role = "all" } = {},
) {
  const selected = loaded.artifact.cases.filter(
    (entry) => entry.split === split && (role === "all" || entry.role === role),
  );
  const results = selected.map((entry) => {
    const label = entry.label;
    let output = {
      text: "Synthetic supplied output for aggregation tests; not actual model inference.",
    };
    if (entry.role === "period_planner")
      output = {
        startDate:
          label.periodConstraints.exactStartDate ??
          label.periodConstraints.mustCoverDates[0],
        endDate:
          label.periodConstraints.exactEndDate ??
          label.periodConstraints.mustCoverDates.at(-1),
        timeZone: "Asia/Seoul",
        reason: "Synthetic context reason; source-review not performed.",
      };
    if (entry.role === "agent_proposals")
      output.operations =
        label.requiredOperation === "none"
          ? []
          : [
              {
                kind: label.requiredOperation,
                targetPath: label.allowedTarget.path,
                targetSha256: label.allowedTarget.sha256,
                previewOnly: true,
                requiresUserApproval: true,
                requiresNativeOwnershipProof: true,
              },
            ];
    return {
      caseId: entry.id,
      caseSha256: entry.caseSha256,
      sourcePacketSha256: entry.sourcePacketSha256,
      labelSha256: entry.labelSha256,
      status: "completed",
      output,
      outputSha256: sha256(encodeJson(output)),
      assessment: {
        schemaPassed: true,
        taskResponse: true,
        usefulnessScore: 4,
        emittedClaimCount: label.requiredFacts.length,
        supportedClaimCount: label.requiredFacts.length,
        coveredFactIds: label.requiredFacts.map((fact) => fact.id),
        criticalMeaningErrors: 0,
        criticalOmissions: 0,
        unauthorizedOperations: 0,
        falsePositiveIssues: 0,
        issueCount: label.expectedIssueCount ?? 0,
      },
    };
  });
  return {
    version: 1,
    kind: "role_assessments",
    suiteId: roleSuiteId,
    suiteManifestSha256: loaded.manifestSha256,
    provenance: "synthetic_mock",
    results,
  };
}
