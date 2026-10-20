import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  encodeJson,
  fixtureRoot,
  sha256,
} from "./local-wiki-eval-fixtures.mjs";
import { roleNames } from "./local-wiki-eval-role-fixtures.mjs";
import { loadAndValidateRoles } from "./local-wiki-eval-role-validate.mjs";
import {
  checkPeriodOutput,
  scoreRoleResults,
} from "./local-wiki-eval-role-score.mjs";
import { parseRoleArguments, runRoles } from "./local-wiki-eval-role-run.mjs";
import {
  temporary,
  referenceAssessments,
} from "./local-wiki-eval-role-test-support.mjs";

test("period checks honor contextual dates, explicit precedence and Asia/Seoul civil bounds", async () => {
  const loaded = await loadAndValidateRoles();
  const contextual = loaded.artifact.cases.find(
    (entry) => entry.id === "period_planner:p01:contextual_recent",
  );
  const explicit = loaded.artifact.cases.find(
    (entry) => entry.id === "period_planner:p01:explicit_date",
  );
  assert.equal(
    checkPeriodOutput(contextual, {
      startDate: "2026-10-01",
      endDate: "2026-10-06",
      timeZone: "Asia/Seoul",
      reason: "Original activity dates",
    }).valid,
    true,
  );
  assert.equal(
    checkPeriodOutput(contextual, {
      startDate: "2026-10-02",
      endDate: "2026-10-08",
      timeZone: "Asia/Seoul",
      reason: "Import date",
    }).valid,
    false,
  );
  const exact = checkPeriodOutput(explicit, {
    startDate: "2026-10-02",
    endDate: "2026-10-02",
    timeZone: "Asia/Seoul",
  });
  assert.equal(exact.valid, true);
  assert.equal(
    exact.interval.startEpoch,
    Date.parse("2026-10-01T15:00:00Z") / 1000,
  );
  assert.equal(
    exact.interval.endEpochExclusive,
    Date.parse("2026-10-02T15:00:00Z") / 1000,
  );
  for (const output of [
    { startDate: "2026-02-30", endDate: "2026-10-02", timeZone: "Asia/Seoul" },
    { startDate: "2026-10-01", endDate: "2026-10-02", timeZone: "Asia/Seoul" },
    { startDate: "2026-10-02", endDate: "2026-10-02", timeZone: "UTC" },
    {
      startDate: "2026-10-02",
      endDate: "2026-10-02",
      timeZone: "Asia/Seoul",
      inventedDeadline: "tomorrow",
    },
  ])
    assert.equal(checkPeriodOutput(explicit, output).valid, false);
});

test("perfect mock assessments meet only reference gates independently per role", async () => {
  const loaded = await loadAndValidateRoles(),
    score = scoreRoleResults(loaded, referenceAssessments(loaded));
  for (const role of roleNames) {
    assert.equal(score.byRole[role].totals.scheduled, 16);
    assert.equal(score.byRole[role].totals.caseSuccess, 16);
    assert.equal(score.byRole[role].referenceGatesMet, true);
  }
  assert.equal(score.referenceGatesMet, true);
  assert.equal(score.semanticAcceptance, "not_evaluated");
  assert.equal(score.labelReviewStatus, "source_review_required");
  assert.equal(score.reviewPerformedByHarness, false);
  assert.equal(score.nativeAuthorityEstablished, false);
});

test("missing and technical failures retain each role's scheduled and coverage denominator", async () => {
  const loaded = await loadAndValidateRoles(),
    input = referenceAssessments(loaded, { role: "audio_script" });
  input.results.splice(0, 1);
  for (const [index, status] of [
    [0, "unavailable"],
    [1, "stopped"],
    [2, "cancelled"],
    [3, "failed"],
  ])
    Object.assign(input.results[index], {
      status,
      output: null,
      assessment: null,
    });
  input.results[4].assessment.usefulnessScore = 99;
  const score = scoreRoleResults(loaded, input, { role: "audio_script" }),
    group = score.byRole.audio_script;
  assert.equal(group.totals.scheduled, 16);
  assert.equal(group.totals.technicalFailure, 6);
  assert.deepEqual(group.technicalFailureCounts, {
    unavailable: 1,
    stopped: 1,
    cancelled: 1,
    invalid: 1,
    failed: 1,
    not_run: 1,
  });
  assert.equal(group.rates.caseSuccess, 10 / 16);
  assert.ok(group.rates.importantFactCoverage < 1);
  assert.equal(group.referenceGates.criticalCasesAssessed, false);
  assert.equal(score.referenceGatesMet, false);
});

test("empty positive audio output and all-noop Agent proposals cannot qualify", async () => {
  const loaded = await loadAndValidateRoles();
  const audio = referenceAssessments(loaded, { role: "audio_script" });
  audio.results[0].output.text = "";
  audio.results[0].outputSha256 = sha256(encodeJson(audio.results[0].output));
  const audioScore = scoreRoleResults(loaded, audio, { role: "audio_script" });
  assert.equal(audioScore.byRole.audio_script.totals.caseSuccess, 15);
  assert.equal(
    audioScore.byRole.audio_script.technicalFailureCounts.invalid,
    1,
  );
  assert.equal(audioScore.referenceGatesMet, false);
  const agent = referenceAssessments(loaded, { role: "agent_proposals" });
  agent.results.forEach((row) => {
    row.output.operations = [];
    row.outputSha256 = sha256(encodeJson(row.output));
  });
  const agentScore = scoreRoleResults(loaded, agent, {
    role: "agent_proposals",
  });
  assert.equal(agentScore.byRole.agent_proposals.totals.caseSuccess, 8);
  assert.equal(agentScore.referenceGatesMet, false);
});

test("wrong raw/target/revision Agent operation fails while fixture booleans issue no authority", async () => {
  const loaded = await loadAndValidateRoles(),
    input = referenceAssessments(loaded, { role: "agent_proposals" });
  input.results[0].output.operations[0].targetPath = "raw/p01/t2/revision-3.md";
  input.results[0].outputSha256 = sha256(encodeJson(input.results[0].output));
  const score = scoreRoleResults(loaded, input, { role: "agent_proposals" });
  assert.equal(score.byRole.agent_proposals.totals.unauthorizedOperations, 1);
  assert.equal(score.referenceGatesMet, false);
  assert.equal(score.nativeAuthorityEstablished, false);
});

test("critical actor/status error, omitted rollback and false issue each independently block role gate", async () => {
  const loaded = await loadAndValidateRoles();
  const input = referenceAssessments(loaded);
  input.results.find(
    (row) => row.caseId === "audio_script:p01:grounded_status_script",
  ).assessment.criticalMeaningErrors = 1;
  input.results
    .find((row) => row.caseId === "reflect:p01:conflicting_proposal")
    .assessment.coveredFactIds.pop();
  input.results.find(
    (row) => row.caseId === "semantic_lint:p01:valid_historical_page",
  ).assessment.issueCount = 1;
  const score = scoreRoleResults(loaded, input);
  assert.equal(score.byRole.audio_script.totals.criticalMeaningErrors, 1);
  assert.equal(score.byRole.reflect.totals.criticalOmissions, 1);
  assert.equal(score.byRole.semantic_lint.totals.falsePositiveIssues, 1);
  assert.equal(score.byRole.semantic_lint.totals.noIssueCasesScheduled, 8);
  assert.equal(score.byRole.semantic_lint.rates.falsePositiveCaseRate, 1 / 8);
  assert.equal(score.byRole.period_planner.referenceGatesMet, true);
  assert.equal(score.byRole.agent_proposals.referenceGatesMet, true);
  assert.equal(score.referenceGatesMet, false);
});

test("task response is mandatory even when usefulness is rated four and facts are labeled covered", async () => {
  const loaded = await loadAndValidateRoles(),
    input = referenceAssessments(loaded, { role: "reflect" });
  input.results[0].assessment.taskResponse = false;
  input.results[1].assessment.taskResponse = false;
  const score = scoreRoleResults(loaded, input, { role: "reflect" });
  assert.equal(score.byRole.reflect.totals.usefulCases, 14);
  assert.equal(score.byRole.reflect.referenceGatesMet, false);
});

test("role scorer refuses cross-split, duplicate, changed output or source identities and execution claims", async () => {
  const loaded = await loadAndValidateRoles();
  const duplicate = referenceAssessments(loaded);
  duplicate.results.push(duplicate.results[0]);
  assert.throws(() => scoreRoleResults(loaded, duplicate), /Duplicate/);
  assert.throws(
    () =>
      scoreRoleResults(
        loaded,
        referenceAssessments(loaded, { split: "held_out" }),
      ),
    /out-of-selection/,
  );
  const changed = referenceAssessments(loaded);
  changed.results[0].output.endDate = "2026-10-08";
  assert.throws(() => scoreRoleResults(loaded, changed), /output hash/);
  const wrongSource = referenceAssessments(loaded);
  wrongSource.results[0].sourcePacketSha256 = "0".repeat(64);
  assert.throws(
    () => scoreRoleResults(loaded, wrongSource),
    /case\/source\/label/,
  );
  const promoted = referenceAssessments(loaded);
  promoted.provenance = "native_human_review_verified";
  assert.throws(
    () => scoreRoleResults(loaded, promoted),
    /identity\/provenance/,
  );
});

test("held-out metadata remains 16 scheduled per role and never performs inference", async () => {
  const loaded = await loadAndValidateRoles(),
    score = scoreRoleResults(
      loaded,
      referenceAssessments(loaded, { split: "held_out" }),
      { split: "held_out" },
    );
  assert.equal(score.caseOutcomes.length, 80);
  for (const group of Object.values(score.byRole))
    assert.equal(group.totals.scheduled, 16);
  assert.equal(score.inferenceExecutedByHarness, false);
});

test("role CLI validates exact selections and receipt keeps inference/review/network unmeasured", async () =>
  temporary(async (directory) => {
    assert.deepEqual(
      parseRoleArguments(["--output", resolve(directory, "run")]),
      { split: "development", role: "all", output: resolve(directory, "run") },
    );
    assert.throws(
      () =>
        parseRoleArguments([
          "--output",
          "/tmp/a",
          "--role",
          "agent_proposals",
          "--role",
          "reflect",
        ]),
      /Duplicate/,
    );
    assert.throws(
      () => parseRoleArguments(["--output", "/tmp/a", "--role", "ask"]),
      /valid role/,
    );
    assert.throws(
      () => parseRoleArguments(["--output", "/tmp/a", "--model", "remote"]),
      /Usage/,
    );
    const result = await runRoles({
      split: "development",
      role: "all",
      output: resolve(directory, "run"),
    });
    assert.equal(result.valid, true);
    assert.equal(result.receipt.selection.caseIds.length, 80);
    assert.equal(result.receipt.inferenceExecuted, false);
    assert.equal(result.receipt.reviewPerformed, false);
    assert.equal(result.receipt.score, null);
    assert.deepEqual(result.receipt.networkObservations, {
      attempted: null,
      blocked: null,
      successful: null,
    });
    await assert.rejects(
      runRoles({
        split: "development",
        role: "all",
        output: resolve(directory, "run"),
      }),
      /EEXIST/,
    );
    await assert.rejects(
      runRoles({
        split: "development",
        role: "all",
        output: resolve(fixtureRoot, "forbidden-output"),
      }),
      /frozen corpus/,
    );
  }));

test("supplied mock role aggregation remains unreviewed and invalid identity is preserved in receipt", async () =>
  temporary(async (directory) => {
    const loaded = await loadAndValidateRoles(),
      input = referenceAssessments(loaded, { role: "reflect" });
    const results = resolve(directory, "results.json");
    await writeFile(results, encodeJson(input));
    const good = await runRoles({
      split: "development",
      role: "reflect",
      output: resolve(directory, "good"),
      results,
    });
    assert.equal(good.valid, true);
    assert.equal(
      good.receipt.score.labelReviewStatus,
      "source_review_required",
    );
    assert.equal(good.receipt.score.semanticAcceptance, "not_evaluated");
    input.results[0].labelSha256 = "0".repeat(64);
    await writeFile(results, encodeJson(input));
    const bad = await runRoles({
      split: "development",
      role: "reflect",
      output: resolve(directory, "bad"),
      results,
    });
    assert.equal(bad.valid, false);
    assert.equal(bad.receipt.score, null);
    assert.match(bad.receipt.tests.at(-1).error, /hash mismatch/);
  }));
