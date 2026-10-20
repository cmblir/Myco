import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  encodeJson,
  fixtureRoot,
  sha256,
  writeFixtures,
} from "./local-wiki-eval-fixtures.mjs";
import { loadAndValidate } from "./local-wiki-eval-validate.mjs";
import {
  buildReviewFixtures,
  reviewId,
  writeReviewFixtures,
} from "./local-wiki-eval-review-fixtures.mjs";
import {
  loadAndValidateReview,
  validateReviewStructures,
} from "./local-wiki-eval-review-validate.mjs";
import { scoreReviewResults } from "./local-wiki-eval-review-score.mjs";
import {
  parseReviewArguments,
  runReview,
} from "./local-wiki-eval-review-run.mjs";

test("frozen reviewer pairs exist separately from the original corpus", async () => {
  const artifact = await readFile(
    resolve(fixtureRoot, "review-pairs.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  assert.notEqual(
    artifact,
    null,
    "Missing separate frozen review-pairs artifact",
  );
  assert.equal(artifact.pairs.length, 40);
  assert.equal(artifact.pairs.flatMap((pair) => pair.cases).length, 80);
});

async function temporary(run) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "myco-review-fixtures-test-"),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function referenceResults(loaded, split = "development") {
  return {
    version: 1,
    kind: "review_verdicts",
    suiteId: reviewId,
    suiteManifestSha256: loaded.manifestSha256,
    provenance: "synthetic_mock",
    results: loaded.artifact.pairs
      .filter((pair) => pair.split === split)
      .flatMap((pair) =>
        pair.cases.map((entry) => ({
          caseId: entry.id,
          sourceSha256: pair.source.sha256,
          originalSpanSha256: pair.originalSpan.sha256,
          proposalSha256: entry.proposalSha256,
          claimSha256: entry.claimSha256,
          status: "completed",
          verdict: entry.label.expectedVerdict,
        })),
      ),
  };
}

test("derivation preserves the original freeze and 16/8/16 same-project pair splits", async () => {
  const loaded = await loadAndValidateReview();
  assert.deepEqual(loaded.artifact, buildReviewFixtures(loaded.base));
  assert.equal(loaded.base.files["corpus.json"].sources.length, 640);
  assert.equal(loaded.base.manifest.artifacts.length, 6);
  assert.equal(loaded.checks.length, 5);
  assert.deepEqual(
    ["development", "calibration", "held_out"].map(
      (split) =>
        loaded.artifact.pairs.filter((pair) => pair.split === split).length,
    ),
    [16, 8, 16],
  );
  assert.deepEqual(loaded.artifact.counts.mutations, {
    actor: 10,
    action: 10,
    eventTime: 10,
    status: 10,
  });
  for (const project of loaded.base.files["corpus.json"].projects)
    assert.equal(
      loaded.artifact.pairs.filter(
        (pair) => pair.projectId === project.id && pair.split === project.split,
      ).length,
      2,
    );
  assert.equal(loaded.artifact.semanticReviewStatus, "source_review_required");
});

test("proof spans use exact UTF-8 bytes and original turn dates rather than import dates", async () => {
  const loaded = await loadAndValidateReview();
  const pair = loaded.artifact.pairs.find((pair) => pair.projectId === "p01");
  const source = loaded.base.files["corpus.json"].sources.find(
    (source) => source.id === pair.source.originalSourceId,
  );
  assert.notEqual(
    pair.originalSpan.startByte,
    source.text.indexOf(pair.originalSpan.text),
  );
  assert.equal(
    Buffer.from(source.text)
      .subarray(pair.originalSpan.startByte, pair.originalSpan.endByte)
      .toString("utf8"),
    pair.originalSpan.text,
  );
  assert.equal(
    pair.cases[0].proposal.claims[0].eventTime.value,
    pair.originalSpan.turnTime,
  );
  assert.notEqual(pair.originalSpan.turnTime, pair.source.importedAt);
  for (const entry of pair.cases)
    assert.equal(entry.proposal.claims[0].verificationId, null);
});

test("all wrong-meaning variants keep valid original IDs and mutate their declared field", async () => {
  const { artifact, base } = await loadAndValidateReview();
  for (const pair of artifact.pairs) {
    const correct = pair.cases[0].proposal.claims[0],
      wrong = pair.cases[1].proposal.claims[0];
    assert.equal(wrong.anchorSpanId, pair.originalSpan.id);
    assert.deepEqual(wrong.supportSpanIds, correct.supportSpanIds);
    assert.equal(wrong.actor.subjectSpanId, pair.originalSpan.id);
    assert.equal(wrong.eventTime.supportSpanId, pair.originalSpan.id);
    assert.equal(wrong.verificationId, null);
    if (pair.mutationKind === "actor") {
      assert.notEqual(wrong.actor.role, pair.originalSpan.speakerRole);
      assert.equal(wrong.actor.basis, "explicit_subject");
    }
    if (pair.mutationKind === "action") {
      const original = base.files["corpus.json"].sources.find(
        (source) => source.id === pair.source.originalSourceId,
      );
      assert.equal(original.text.includes(wrong.action), false);
      assert.match(wrong.action, /feature-99/);
    }
    if (pair.mutationKind === "eventTime") {
      assert.equal(wrong.eventTime.value, pair.source.importedAt);
      assert.notEqual(wrong.eventTime.value, correct.eventTime.value);
      assert.equal(wrong.eventTime.basis, "date_reference");
    }
    if (pair.mutationKind === "status") {
      assert.equal(correct.speechAct, "report");
      assert.equal(correct.status, "reported_completed");
      assert.equal(wrong.status, "reported_failed");
    }
  }
});

test("rejects shifted byte offsets even when span text/hash metadata is unchanged", async () => {
  const loaded = await loadAndValidateReview(),
    changed = structuredClone(loaded.artifact);
  changed.pairs[0].originalSpan.startByte += 1;
  assert.throws(
    () => validateReviewStructures(changed, loaded.base),
    /UTF-8 span\/hash/,
  );
});

test("rejects changed original speaker, source revision or project split", async () => {
  const loaded = await loadAndValidateReview();
  for (const [edit, pattern] of [
    [
      (artifact) => (artifact.pairs[0].originalSpan.speakerRole = "assistant"),
      /speaker\/time/,
    ],
    [(artifact) => (artifact.pairs[0].source.revision = 99), /source metadata/],
    [(artifact) => (artifact.pairs[0].split = "held_out"), /project\/split/],
  ]) {
    const changed = structuredClone(loaded.artifact);
    edit(changed);
    assert.throws(
      () => validateReviewStructures(changed, loaded.base),
      pattern,
    );
  }
});

test("rejects changed proposal/claim hashes, labels and semantic-review promotion", async () => {
  const loaded = await loadAndValidateReview();
  const proposal = structuredClone(loaded.artifact);
  proposal.pairs[0].cases[1].proposal.claims[0].action += " invented";
  assert.throws(
    () => validateReviewStructures(proposal, loaded.base),
    /hash mismatch/,
  );
  const label = structuredClone(loaded.artifact);
  label.pairs[0].cases[1].label.expectedVerdict = "accept";
  label.pairs[0].cases[1].labelSha256 = sha256(
    encodeJson(label.pairs[0].cases[1].label),
  );
  assert.throws(
    () => validateReviewStructures(label, loaded.base),
    /verdict label/,
  );
  const promoted = structuredClone(loaded.artifact);
  promoted.semanticReviewStatus = "human_reviewed";
  assert.throws(
    () => validateReviewStructures(promoted, loaded.base),
    /source-review-required/,
  );
});

test("derived publishing never overwrites frozen artifacts or its own existing freeze", async () =>
  temporary(async (directory) => {
    await writeFixtures(directory);
    const before = await readFile(resolve(directory, "manifest.json"));
    await writeReviewFixtures(directory);
    assert.deepEqual(
      await readFile(resolve(directory, "manifest.json")),
      before,
    );
    await assert.rejects(writeReviewFixtures(directory), /EEXIST/);
    await loadAndValidateReview(directory);
  }));

test("rejects changed derived bytes, unsafe manifest path and artifact symlink", async () =>
  temporary(async (directory) => {
    await writeFixtures(directory);
    await writeReviewFixtures(directory);
    const original = await readFile(resolve(directory, "review-pairs.json"));
    await writeFile(
      resolve(directory, "review-pairs.json"),
      Buffer.concat([original, Buffer.from(" ")]),
    );
    await assert.rejects(
      loadAndValidateReview(directory),
      /artifact hash mismatch/,
    );
    await writeFile(resolve(directory, "review-pairs.json"), original);
    const manifest = JSON.parse(
      await readFile(resolve(directory, "review-pairs.manifest.json"), "utf8"),
    );
    manifest.artifact.path = "../review-pairs.json";
    await writeFile(
      resolve(directory, "review-pairs.manifest.json"),
      encodeJson(manifest),
    );
    await assert.rejects(
      loadAndValidateReview(directory),
      /unsafe review manifest/,
    );
    manifest.artifact.path = "review-pairs.json";
    await writeFile(
      resolve(directory, "review-pairs.manifest.json"),
      encodeJson(manifest),
    );
    await writeFile(resolve(directory, "copy.json"), original);
    await rm(resolve(directory, "review-pairs.json"));
    await symlink(
      resolve(directory, "copy.json"),
      resolve(directory, "review-pairs.json"),
    );
    await assert.rejects(
      loadAndValidateReview(directory),
      /regular local file/,
    );
  }));

test("perfect synthetic verdicts can meet reference gates but cannot claim semantic acceptance", async () => {
  const loaded = await loadAndValidateReview();
  const score = scoreReviewResults(loaded, referenceResults(loaded));
  assert.equal(score.totals.scheduled, 32);
  assert.equal(score.totals.correctAccepted, 16);
  assert.equal(score.totals.incorrectRejected, 16);
  assert.equal(score.referenceGatesMet, true);
  assert.equal(score.pairedCounts.success, 16);
  assert.equal(score.semanticAcceptance, "not_evaluated");
  assert.equal(score.labelReviewStatus, "source_review_required");
  assert.equal(score.inferenceExecutedByHarness, false);
});

test("zero wrong acceptance does not qualify universal rejection", async () => {
  const loaded = await loadAndValidateReview(),
    input = referenceResults(loaded);
  input.results.forEach((row) => (row.verdict = "reject"));
  const score = scoreReviewResults(loaded, input);
  assert.equal(score.totals.falseAcceptance, 0);
  assert.equal(score.totals.falseRejection, 16);
  assert.equal(score.rates.correctProposalAcceptance, 0);
  assert.equal(score.referenceGatesMet, false);
  assert.equal(score.pairedCounts.falseRejection, 16);
});

test("one critical wrong-meaning acceptance fails despite otherwise correct verdicts", async () => {
  const loaded = await loadAndValidateReview(),
    input = referenceResults(loaded);
  input.results[1].verdict = "accept";
  const score = scoreReviewResults(loaded, input);
  assert.equal(score.totals.falseAcceptance, 1);
  assert.equal(score.rates.falseAcceptance, 1 / 16);
  assert.equal(score.referenceGatesMet, false);
  assert.equal(score.pairedCounts.falseAcceptance, 1);
  assert.equal(score.pairedCounts.success, 15);
});

test("missing, unavailable, stopped, cancelled and invalid verdicts stay in denominators", async () => {
  const loaded = await loadAndValidateReview(),
    input = referenceResults(loaded);
  input.results.splice(0, 1);
  for (const [index, status] of [
    [1, "unavailable"],
    [3, "stopped"],
    [5, "cancelled"],
    [7, "failed"],
  ])
    Object.assign(input.results[index], { status, verdict: null });
  input.results[9].verdict = "maybe";
  const score = scoreReviewResults(loaded, input);
  assert.equal(score.totals.scheduled, 32);
  assert.equal(score.totals.technicalFailure, 6);
  assert.deepEqual(score.technicalFailureCounts, {
    unavailable: 1,
    stopped: 1,
    cancelled: 1,
    invalid: 1,
    failed: 1,
    not_run: 1,
  });
  assert.equal(score.totals.correctAccepted, 10);
  assert.equal(score.rates.correctProposalAcceptance, 10 / 16);
  assert.equal(score.rates.caseSuccess, 26 / 32);
  assert.equal(score.rates.technicalFailure, 6 / 32);
  assert.equal(score.referenceGatesMet, false);
});

test("missing incorrect proposals cannot masquerade as zero-false-acceptance proof", async () => {
  const loaded = await loadAndValidateReview(),
    input = referenceResults(loaded);
  input.results = input.results.filter((row) => row.verdict === "accept");
  const score = scoreReviewResults(loaded, input);
  assert.equal(score.rates.correctProposalAcceptance, 1);
  assert.equal(score.totals.falseAcceptance, 0);
  assert.equal(score.totals.technicalFailure, 16);
  assert.equal(score.referenceGates.incorrectVerdictsComplete, false);
  assert.equal(score.referenceGatesMet, false);
});

test("calibration and held-out selection retain their own fixed scheduled counts", async () => {
  const loaded = await loadAndValidateReview();
  for (const [split, cases, pairs] of [
    ["calibration", 16, 8],
    ["held_out", 32, 16],
  ]) {
    const score = scoreReviewResults(
      loaded,
      referenceResults(loaded, split),
      split,
    );
    assert.equal(score.totals.scheduled, cases);
    assert.equal(score.pairedCounts.scheduled, pairs);
    assert.equal(score.semanticAcceptance, "not_evaluated");
  }
});

test("rejects duplicate, out-of-split and hash-mismatched supplied results", async () => {
  const loaded = await loadAndValidateReview();
  const duplicate = referenceResults(loaded);
  duplicate.results.push(duplicate.results[0]);
  assert.throws(() => scoreReviewResults(loaded, duplicate), /Duplicate/);
  const wrongSplit = referenceResults(loaded, "held_out");
  assert.throws(() => scoreReviewResults(loaded, wrongSplit), /out-of-split/);
  const wrongHash = referenceResults(loaded);
  wrongHash.results[0].claimSha256 = "0".repeat(64);
  assert.throws(
    () => scoreReviewResults(loaded, wrongHash),
    /source\/claim identity/,
  );
  const stale = referenceResults(loaded);
  stale.suiteManifestSha256 = "0".repeat(64);
  assert.throws(() => scoreReviewResults(loaded, stale), /suite identity/);
});

test("rejects technical failures carrying acceptance and unsupported execution provenance", async () => {
  const loaded = await loadAndValidateReview(),
    input = referenceResults(loaded);
  input.results[0].status = "unavailable";
  assert.throws(() => scoreReviewResults(loaded, input), /Technical failure/);
  input.results[0].status = "completed";
  input.provenance = "actual_native_model_verified";
  assert.throws(
    () => scoreReviewResults(loaded, input),
    /unverified or synthetic/,
  );
});

test("review CLI defaults to dev, rejects duplicate/unknown arguments and relative paths", () => {
  assert.deepEqual(parseReviewArguments(["--output", "/tmp/synthetic"]), {
    split: "development",
    output: "/tmp/synthetic",
  });
  assert.throws(
    () =>
      parseReviewArguments([
        "--output",
        "/tmp/a",
        "--split",
        "development",
        "--split",
        "held_out",
      ]),
    /Duplicate/,
  );
  assert.throws(
    () => parseReviewArguments(["--output", "relative"]),
    /Absolute/,
  );
  assert.throws(
    () => parseReviewArguments(["--output", "/tmp/a", "--model", "remote"]),
    /Usage/,
  );
});

test("runner receipt records artifact/tool identity without inference or measured network claims", async () =>
  temporary(async (directory) => {
    const result = await runReview({
      split: "development",
      output: resolve(directory, "run"),
    });
    assert.equal(result.valid, true);
    assert.equal(result.receipt.sourceSnapshots.length, 16);
    assert.equal(result.receipt.tools.length, 7);
    assert.equal(result.receipt.score, null);
    assert.equal(result.receipt.inferenceExecuted, false);
    assert.equal(result.receipt.modelQuality, "not_evaluated");
    assert.equal(result.receipt.labelReviewStatus, "source_review_required");
    assert.deepEqual(result.receipt.networkObservations, {
      attempted: null,
      blocked: null,
      successful: null,
    });
    await assert.rejects(
      runReview({ split: "development", output: resolve(directory, "run") }),
      /EEXIST/,
    );
  }));

test("runner rejects frozen-corpus output containment before writing", async () => {
  await assert.rejects(
    runReview({
      split: "development",
      output: resolve(fixtureRoot, "forbidden-new-output"),
    }),
    /frozen corpus/,
  );
});

test("supplied-result receipt identifies mock scoring and retains invalid input failure", async () =>
  temporary(async (directory) => {
    const loaded = await loadAndValidateReview(),
      input = referenceResults(loaded);
    const results = resolve(directory, "results.json");
    await writeFile(results, encodeJson(input));
    const good = await runReview({
      split: "development",
      output: resolve(directory, "good"),
      results,
    });
    assert.equal(good.valid, true);
    assert.equal(good.receipt.score.inputProvenance, "synthetic_mock");
    assert.equal(good.receipt.score.semanticAcceptance, "not_evaluated");
    assert.equal(good.receipt.suppliedResultsSha256, sha256(encodeJson(input)));
    input.results[0].proposalSha256 = "0".repeat(64);
    await writeFile(results, encodeJson(input));
    const bad = await runReview({
      split: "development",
      output: resolve(directory, "bad"),
      results,
    });
    assert.equal(bad.valid, false);
    assert.equal(bad.receipt.score, null);
    assert.match(bad.receipt.tests.at(-1).error, /identity mismatch/);
  }));
