import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { encodeJson, sha256 } from "./local-wiki-eval-fixtures.mjs";
import { reviewId, reviewStatus } from "./local-wiki-eval-review-fixtures.mjs";
import { validateReviewPairs } from "./local-wiki-eval-review-validate.mjs";

const hashPattern = /^[a-f0-9]{64}$/;
const pairCounts = { development: 16, calibration: 8, held_out: 16 };
const provenance = "deterministic_synthetic_reference_not_human_reviewed";
const gates = {
  maxCriticalWrongMeaningAcceptance: 0,
  minCorrectProposalAcceptance: 0.9,
  requiresAllIncorrectVerdicts: true,
};
const auditChecks = [
  "frozen base artifact identity",
  "derived project split isolation",
  "original UTF-8 span/speaker/time bindings",
  "paired claim/label identities and one-field mutations",
  "unreviewed semantic status",
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys) {
  return value && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function sameFile(first, second) {
  return second.isFile() && !second.isSymbolicLink() &&
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
      (key) => first[key] === second[key],
    );
}

/** Bound allocation and reject symlinks/replacement before parsing any bytes. */
async function readPinned(path, expectedSha256, expectedBytes, limit) {
  requireValue(hashPattern.test(expectedSha256), "Frozen bundle hash is required");
  requireValue(await realpath(dirname(path)) === dirname(path), "Bundle directory cannot traverse symlinks");
  const before = await lstat(path, { bigint: true });
  requireValue(
    before.isFile() && !before.isSymbolicLink() &&
      before.size > 0n && before.size <= BigInt(limit) &&
      (expectedBytes === null || before.size === BigInt(expectedBytes)),
    "Bundle input must be a bounded regular file with the pinned size",
  );
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    requireValue(sameFile(before, await file.stat({ bigint: true })), "Bundle file changed before read");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    requireValue(
      size === Number(before.size) &&
        sameFile(before, await file.stat({ bigint: true })) &&
        sameFile(before, await lstat(path, { bigint: true })) &&
        await realpath(dirname(path)) === dirname(path),
      "Bundle file changed during read",
    );
    const bytes = buffer.subarray(0, size);
    requireValue(sha256(bytes) === expectedSha256, "Bundle input hash mismatch");
    try {
      return JSON.parse(bytes);
    } catch {
      throw new Error("Bundle input must be valid JSON");
    }
  } finally {
    await file.close();
  }
}

/** Preserve the complete selected schedule, including every failed or absent result. */
export function reviewSnapshots(pairs) {
  return pairs.map((pair) => ({
    pairId: pair.id,
    originalSourceId: pair.source.originalSourceId,
    sha256: pair.source.sha256,
    originalSpanSha256: pair.originalSpan.sha256,
    caseSnapshots: pair.cases.map((entry) => ({
      caseId: entry.id,
      proposalSha256: entry.proposalSha256,
      claimSha256: entry.claimSha256,
      labelSha256: entry.labelSha256,
    })),
  }));
}

/** The caller pins this separately audited projection before inference.
 * This binds a prior audit receipt; it does not revalidate the whole corpus or
 * prove projection completeness independently of that trusted frozen input.
 */
export async function loadReviewBundle(path, expectedSha256, split) {
  requireValue(
    isAbsolute(path) && path === resolve(path) && Object.hasOwn(pairCounts, split) &&
      hashPattern.test(expectedSha256),
    "Bundle requires an absolute normalized path, known split, and frozen SHA256",
  );
  const directory = dirname(path);
  const bundle = await readPinned(path, expectedSha256, null, 64 * 1024);
  requireValue(
    exactKeys(bundle, ["version", "kind", "suiteId", "split", "parentAudit", "artifact", "sources"]) &&
      bundle.version === 1 && bundle.kind === "review_split_bundle" &&
      bundle.suiteId === reviewId && bundle.split === split,
    "Bundle identity/split mismatch",
  );
  for (const [key, filename] of [
    ["parentAudit", "parent-audit.json"],
    ["artifact", "selected-review.json"],
    ["sources", "selected-sources.json"],
  ]) {
    const entry = bundle[key];
    requireValue(
      exactKeys(entry, ["path", "bytes", "sha256"]) &&
        entry.path === filename && entry.path !== basename(path) &&
        Number.isSafeInteger(entry.bytes) && entry.bytes > 0 &&
        entry.bytes <= 4 * 1024 * 1024 && hashPattern.test(entry.sha256),
      "Invalid bundle single-component file descriptor",
    );
  }
  const read = (key) => {
    const entry = bundle[key];
    return readPinned(resolve(directory, entry.path), entry.sha256, entry.bytes, 4 * 1024 * 1024);
  };
  const parent = await read("parentAudit");
  requireValue(
    parent.version === 1 && parent.kind === "review_fixture_or_supplied_verdicts" &&
      parent.split === split && parent.fixtureStatus === "valid" &&
      parent.inferenceExecuted === false && parent.modelQuality === "not_evaluated" &&
      parent.labelReviewStatus === reviewStatus &&
      [undefined, "whole_corpus_before_split"].includes(parent.inputReadScope) &&
      Array.isArray(parent.tests) && parent.tests.every((entry) => entry.status === "passed") &&
      auditChecks.every((name) => parent.tests.some((entry) => entry.name === name)) &&
      ["baseManifestSha256", "configSha256", "suiteManifestSha256", "suiteArtifactSha256"]
        .every((key) => hashPattern.test(parent[key])),
    "Parent whole-validation audit identity/status mismatch",
  );
  const artifact = await read("artifact");
  const originals = await read("sources");
  requireValue(
    exactKeys(artifact, ["version", "id", "syntheticOnly", "baseManifestSha256", "labelStatus",
      "semanticReviewStatus", "provenance", "split", "gates", "pairs"]) &&
      artifact.version === 1 && artifact.id === reviewId && artifact.syntheticOnly === true &&
      artifact.baseManifestSha256 === parent.baseManifestSha256 &&
      artifact.labelStatus === "frozen_before_inference" &&
      artifact.semanticReviewStatus === reviewStatus && artifact.provenance === provenance &&
      artifact.split === split && encodeJson(artifact.gates) === encodeJson(gates) &&
      artifact.pairs?.length === pairCounts[split] &&
      artifact.pairs.every((pair) => pair.split === split),
    "Selected review artifact identity/schedule mismatch",
  );
  requireValue(
    exactKeys(originals, ["version", "split", "sources"]) &&
      originals.version === 1 && originals.split === split && Array.isArray(originals.sources),
    "Selected originals identity mismatch",
  );
  const sourceIds = artifact.pairs.map((pair) => pair.source.originalSourceId);
  const projectIds = [...new Set(artifact.pairs.map((pair) => pair.projectId))];
  requireValue(
    new Set(sourceIds).size === sourceIds.length &&
      originals.sources.length === sourceIds.length &&
      new Set(originals.sources.map((source) => source.id)).size === sourceIds.length &&
      projectIds.length === pairCounts[split] / 2 &&
      projectIds.every((id) => artifact.pairs.filter((pair) => pair.projectId === id).length === 2) &&
      originals.sources.every((source) =>
        exactKeys(source, ["id", "projectId", "familyId", "kind", "path", "sha256",
          "revision", "importedAt", "modifiedAt", "text"]) &&
        sourceIds.includes(source.id) && typeof source.text === "string" &&
        source.kind === "raw" && source.sha256 === sha256(source.text)),
    "Selected original membership/hash mismatch",
  );
  validateReviewPairs(artifact, {
    files: {
      "corpus.json": { sources: originals.sources },
      "config.json": { splits: { [split]: projectIds } },
    },
  });
  requireValue(
    encodeJson(reviewSnapshots(artifact.pairs)) === encodeJson(parent.sourceSnapshots),
    "Selected schedule/snapshots differ from the complete parent audit selection",
  );
  return {
    artifact,
    manifestSha256: parent.suiteManifestSha256,
    checks: ["frozen split bundle and bounded file identities", "selected original/pair rules",
      "complete selected schedule bound to parent audit"],
    bundle: {
      split,
      sha256: expectedSha256,
      parentAuditSha256: bundle.parentAudit.sha256,
      selectedArtifactSha256: bundle.artifact.sha256,
      selectedSourcesSha256: bundle.sources.sha256,
      parentAuditRevalidated: false,
      trust: "caller_pinned_before_inference_requires_separately_audited_materialization",
      parent: Object.fromEntries(
        ["baseManifestSha256", "configSha256", "suiteManifestSha256", "suiteArtifactSha256"]
          .map((key) => [key, parent[key]]),
      ),
    },
  };
}
