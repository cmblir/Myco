import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { encodeJson, sha256 } from "./local-wiki-eval-fixtures.mjs";
import { proposalForSpan, reviewId, reviewStatus } from "./local-wiki-eval-review-fixtures.mjs";
import { loadReviewBundle, reviewSnapshots } from "./local-wiki-eval-review-bundle.mjs";
import { parseReviewArguments } from "./local-wiki-eval-review-run.mjs";
import { scoreReviewResults } from "./local-wiki-eval-review-score.mjs";
import { validateReviewStructures } from "./local-wiki-eval-review-validate.mjs";

const provenance = "deterministic_synthetic_reference_not_human_reviewed";

// Invent only the selected split. No fixture generator or real corpus is read.
async function fixture(t) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "myco-review-bundle-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = resolve(root, "bundle");
  await mkdir(directory);
  const sources = [], pairs = [];
  for (let index = 0; index < 16; index += 1) {
    const projectId = `synthetic_project_${Math.floor(index / 2)}`;
    const speakerRole = index % 2 ? "assistant" : "user";
    const marker = speakerRole === "user" ? "User request: " : "Assistant report: ";
    const turnTime = "2026-01-01T10:00:00Z";
    const text = `${turnTime} · ${marker}Check synthetic-${projectId}-feature-2.`;
    const prefix = "Synthetic 한국어 record.\n";
    const source = {
      id: `source-${index}`, projectId, familyId: `family-${index}`, kind: "raw",
      path: `raw/synthetic-${index}.md`, revision: 1, importedAt: "2026-02-01T00:00:00Z",
      modifiedAt: "2026-02-01T00:00:00Z", text: `${prefix}${text}\n`,
    };
    source.sha256 = sha256(source.text);
    sources.push(source);
    const span = {
      id: `span_${index}`, speakerRole, turnTime, startByte: Buffer.byteLength(prefix),
      endByte: Buffer.byteLength(prefix + text), text, sha256: sha256(text),
    };
    const mutationKind = ["actor", "action", "eventTime", "status"][index % 4];
    const supported = proposalForSpan(span), wrong = structuredClone(supported);
    const claim = wrong.claims[0];
    if (mutationKind === "actor") claim.actor.role = speakerRole === "user" ? "assistant" : "user";
    if (mutationKind === "action") claim.action = claim.action.replace("feature-2", "feature-99");
    if (mutationKind === "eventTime") Object.assign(claim.eventTime, {
      value: source.importedAt, basis: "date_reference", uncertainty: "inferred",
    });
    if (mutationKind === "status") claim.status = "reported_failed";
    const id = `synthetic-pair-${index}`;
    const cases = [supported, wrong].map((proposal, variant) => {
      const label = {
        expectedVerdict: variant ? "reject" : "accept", critical: !!variant,
        mutationKind: variant ? mutationKind : null, reviewStatus, provenance,
      };
      return {
        id: `${id}:${variant}`, variant: variant ? "wrong_meaning" : "source_supported",
        proposal, proposalSha256: sha256(encodeJson(proposal)),
        claimSha256: sha256(encodeJson(proposal.claims[0])),
        label, labelSha256: sha256(encodeJson(label)),
      };
    });
    const { text: _text, projectId: _project, familyId: _family, ...sourceMetadata } = source;
    pairs.push({
      id, projectId, familyId: source.familyId, split: "development", scope: "all", mutationKind,
      source: { ...sourceMetadata, id: `source_${index}`, originalSourceId: source.id },
      originalSpan: span, cases,
    });
  }
  const parent = {
    version: 1, kind: "review_fixture_or_supplied_verdicts", split: "development",
    inputReadScope: "whole_corpus_before_split", fixtureStatus: "valid",
    inferenceExecuted: false, modelQuality: "not_evaluated", labelReviewStatus: reviewStatus,
    baseManifestSha256: sha256("synthetic parent manifest"),
    configSha256: sha256("synthetic config"), suiteManifestSha256: sha256("synthetic review manifest"),
    suiteArtifactSha256: sha256("synthetic full review artifact"),
    sourceSnapshots: reviewSnapshots(pairs),
    tests: ["frozen base artifact identity", "derived project split isolation",
      "original UTF-8 span/speaker/time bindings", "paired claim/label identities and one-field mutations",
      "unreviewed semantic status"].map((name) => ({ name, status: "passed" })),
  };
  const artifact = {
    version: 1, id: reviewId, syntheticOnly: true, baseManifestSha256: parent.baseManifestSha256,
    labelStatus: "frozen_before_inference", semanticReviewStatus: reviewStatus, provenance,
    split: "development", gates: {
      maxCriticalWrongMeaningAcceptance: 0, minCorrectProposalAcceptance: 0.9,
      requiresAllIncorrectVerdicts: true,
    }, pairs,
  };
  const originals = { version: 1, split: "development", sources };
  const bundle = { version: 1, kind: "review_split_bundle", suiteId: reviewId, split: "development" };
  const path = resolve(directory, "bundle.json");
  async function freeze() {
    for (const [key, name, value] of [
      ["parentAudit", "parent-audit.json", parent], ["artifact", "selected-review.json", artifact],
      ["sources", "selected-sources.json", originals],
    ]) {
      const bytes = encodeJson(value);
      await writeFile(resolve(directory, name), bytes);
      bundle[key] = { path: name, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
    }
    await writeFile(path, encodeJson(bundle));
    return sha256(encodeJson(bundle));
  }
  return { root, directory, path, parent, artifact, originals, bundle, freeze, pin: await freeze() };
}

function results(loaded, verdict) {
  return {
    version: 1, kind: "review_verdicts", suiteId: reviewId,
    suiteManifestSha256: loaded.manifestSha256, provenance: "synthetic_mock",
    results: loaded.artifact.pairs.flatMap((pair) => pair.cases.map((entry) => ({
      caseId: entry.id, sourceSha256: pair.source.sha256, originalSpanSha256: pair.originalSpan.sha256,
      proposalSha256: entry.proposalSha256, claimSha256: entry.claimSha256,
      status: "completed", verdict: verdict ?? entry.label.expectedVerdict,
    }))),
  };
}

test("selected-only bundle binds every snapshot and preserves all scheduled denominators", async (t) => {
  const f = await fixture(t), loaded = await loadReviewBundle(f.path, f.pin, "development");
  assert.equal(loaded.bundle.parentAuditRevalidated, false);
  assert.equal(loaded.bundle.parentAuditSha256, f.bundle.parentAudit.sha256);
  assert.equal(scoreReviewResults(loaded, results(loaded)).totals.scheduled, 32);
  const missing = results(loaded);
  missing.results = [];
  const scored = scoreReviewResults(loaded, missing);
  assert.equal(scored.totals.technicalFailure, 32);
  assert.equal(scored.technicalFailureCounts.not_run, 32);
  assert.equal(scored.referenceGatesMet, false);
  assert.equal(scoreReviewResults(loaded, results(loaded, "reject")).referenceGatesMet, false);
  assert.throws(() => scoreReviewResults(loaded, missing, "held_out"), /frozen bundle/);
  assert.throws(() => validateReviewStructures(f.artifact, {
    manifestSha256: f.parent.baseManifestSha256,
  }), /Expected 40/);
});

test("bundle SHA and selected split fail before any referenced artifact is opened", async (t) => {
  const f = await fixture(t);
  await unlink(resolve(f.directory, "parent-audit.json"));
  await assert.rejects(loadReviewBundle(f.path, "0".repeat(64), "development"), /hash mismatch/);
  await assert.rejects(loadReviewBundle(f.path, f.pin, "held_out"), /split mismatch/);
});

test("truncated, reordered and cross-split schedules cannot shrink the parent denominator", async (t) => {
  for (const mutate of [
    (f) => f.artifact.pairs.pop(),
    (f) => f.artifact.pairs.reverse(),
    (f) => { f.artifact.pairs[0].split = "held_out"; },
    (f) => f.parent.sourceSnapshots.pop(),
    (f) => { f.parent.sourceSnapshots[0].caseSnapshots[0].labelSha256 = "0".repeat(64); },
  ]) {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(loadReviewBundle(f.path, await f.freeze(), "development"), /schedule|snapshots/);
  }
});

test("invalid parent audit, extra originals and changed source bytes are rejected", async (t) => {
  for (const mutate of [
    (f) => { f.parent.tests[0].status = "failed"; },
    (f) => { f.parent.inputReadScope = "frozen_split_bundle"; },
    (f) => { f.parent.suiteManifestSha256 = "invalid"; },
    (f) => f.originals.sources.push({ ...f.originals.sources[0], id: "unselected" }),
    (f) => { f.originals.sources[0].text += "changed"; },
    (f) => { f.artifact.pairs[0].originalSpan.startByte += 1; },
  ]) {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(loadReviewBundle(f.path, await f.freeze(), "development"));
  }
});

test("symlinks, unsafe descriptors, size limits and hash changes fail closed", async (t) => {
  for (const filename of ["bundle.json", "parent-audit.json", "selected-review.json", "selected-sources.json"]) {
    const f = await fixture(t), path = resolve(f.directory, filename);
    await unlink(path);
    await symlink(resolve(f.root, "unselected-file-never-created.json"), path);
    await assert.rejects(loadReviewBundle(f.path, f.pin, "development"), /regular file/);
  }
  for (const entry of [
    { path: "../unselected.json" }, { bytes: 4 * 1024 * 1024 + 1 }, { bytes: 1 },
    { sha256: "0".repeat(64) },
  ]) {
    const f = await fixture(t);
    Object.assign(f.bundle.artifact, entry);
    await writeFile(f.path, encodeJson(f.bundle));
    await assert.rejects(loadReviewBundle(f.path, sha256(encodeJson(f.bundle)), "development"));
  }
  const f = await fixture(t);
  await symlink(f.directory, resolve(f.root, "alias"));
  await assert.rejects(
    loadReviewBundle(resolve(f.root, "alias", "bundle.json"), f.pin, "development"), /symlinks/,
  );
});

test("CLI requires both explicit bundle inputs and preserves the legacy default", () => {
  const base = ["--output", "/synthetic/output"];
  assert.deepEqual(parseReviewArguments(base), { split: "development", output: "/synthetic/output" });
  for (const args of [
    ["--bundle", "/synthetic/bundle.json"], ["--bundle-sha256", "0".repeat(64)],
    ["--bundle", "relative", "--bundle-sha256", "0".repeat(64)],
    ["--bundle", "/synthetic/bundle.json", "--bundle-sha256", "bad"],
  ]) assert.throws(() => parseReviewArguments([...base, ...args]), /both required/);
});

test("runner reads no corpus cases, preserves output containment and never falls back", async (t) => {
  const f = await fixture(t);
  const scripts = resolve(f.root, "app", "scripts");
  const frozenRoot = resolve(f.root, "app/src-tauri/eval/local-wiki-v1");
  await mkdir(scripts, { recursive: true });
  await mkdir(frozenRoot, { recursive: true });
  // Copy source only. The empty temp corpus permits the directory output guard;
  // opening any corpus manifest/artifact/case still fails rather than reading real data.
  for (const filename of [
    "local-wiki-eval-fixtures.mjs", "local-wiki-eval-validate.mjs",
    ...["fixtures", "validate", "score", "run", "test", "bundle", "bundle-test"]
      .map((name) => `local-wiki-eval-review-${name}.mjs`),
  ]) await copyFile(resolve(dirname(fileURLToPath(import.meta.url)), filename), resolve(scripts, filename));
  const runner = await import(pathToFileURL(resolve(scripts, "local-wiki-eval-review-run.mjs")));
  const good = await runner.runReview({
    split: "development", bundle: f.path, bundleSha256: f.pin, output: resolve(f.root, "good"),
  });
  assert.equal(good.valid, true);
  assert.equal(good.receipt.sourceSnapshots.length, 16);
  assert.equal(good.receipt.inputReadScope, "frozen_split_bundle");
  assert.equal(good.receipt.inferenceExecuted, false);
  assert.equal(good.receipt.labelReviewStatus, "source_review_required");
  const bad = await runner.runReview({
    split: "development", bundle: f.path, bundleSha256: "0".repeat(64), output: resolve(f.root, "bad"),
  });
  assert.equal(bad.valid, false);
  assert.match(bad.receipt.tests.at(-1).error, /hash mismatch/);
  await assert.rejects(lstat(resolve(frozenRoot, "manifest.json")), { code: "ENOENT" });
  const alias = resolve(f.root, "corpus-alias");
  await symlink(frozenRoot, alias);
  for (const output of [resolve(frozenRoot, "forbidden"), resolve(alias, "forbidden"),
    resolve(f.directory, "forbidden")]) {
    await assert.rejects(runner.runReview({
      split: "development", bundle: f.path, bundleSha256: f.pin, output,
    }), /Output cannot be inside the frozen/);
  }
});
