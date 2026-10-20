import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  encodeJson,
  fixtureRoot,
  sha256,
} from "./local-wiki-eval-fixtures.mjs";
import { loadAndValidate, splits } from "./local-wiki-eval-validate.mjs";
import {
  buildReviewFixtures,
  proposalForSpan,
  reviewArtifactName,
  reviewId,
  reviewManifestName,
  reviewStatus,
} from "./local-wiki-eval-review-fixtures.mjs";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** Check shape and original-byte bindings, without executing the native claim validator. */
export function validateReviewStructures(artifact, base) {
  requireValue(
    artifact.id === reviewId &&
      artifact.syntheticOnly === true &&
      artifact.baseManifestSha256 === base.manifestSha256,
    "Review suite/base identity mismatch",
  );
  requireValue(
    artifact.labelStatus === "frozen_before_inference" &&
      artifact.semanticReviewStatus === reviewStatus &&
      artifact.provenance ===
        "deterministic_synthetic_reference_not_human_reviewed",
    "Review labels must remain source-review-required synthetic references",
  );
  requireValue(artifact.pairs?.length === 40, "Expected 40 review pairs");
  const { caseIds, mutationCounts } = validateReviewPairs(artifact, base);
  const projectSplits = base.files["config.json"].splits;
  requireValue(
    caseIds.size === 80 &&
      Object.values(mutationCounts).every((count) => count === 10),
    "Review verdict/mutation counts mismatch",
  );
  for (const [split, count] of [
    ["development", 16],
    ["calibration", 8],
    ["held_out", 16],
  ]) {
    requireValue(
      artifact.pairs.filter((pair) => pair.split === split).length === count &&
        encodeJson(artifact.splits[split]?.projectIds) ===
          encodeJson(projectSplits[split]) &&
        encodeJson(artifact.splits[split]?.pairIds) ===
          encodeJson(
            artifact.pairs
              .filter((pair) => pair.split === split)
              .map((pair) => pair.id),
          ),
      "Review project split leakage/count mismatch",
    );
  }
  requireValue(
    splits.every((split) =>
      projectSplits[split].every(
        (id) =>
          artifact.pairs.filter((pair) => pair.projectId === id).length === 2,
      ),
    ),
    "Each existing project must have exactly two review pairs",
  );
  requireValue(
    encodeJson(artifact) === encodeJson(buildReviewFixtures(base)),
    "Review artifact differs from frozen deterministic derivation",
  );
  return [
    "frozen base artifact identity",
    "derived project split isolation",
    "original UTF-8 span/speaker/time bindings",
    "paired claim/label identities and one-field mutations",
    "unreviewed semantic status",
  ];
}

/** Recheck each selected original and paired proposal using the whole-suite rules. */
export function validateReviewPairs(artifact, base) {
  const sources = new Map(
    base.files["corpus.json"].sources.map((source) => [source.id, source]),
  );
  const projectSplits = base.files["config.json"].splits;
  const pairIds = new Set(),
    caseIds = new Set();
  const mutationCounts = { actor: 0, action: 0, eventTime: 0, status: 0 };
  for (const pair of artifact.pairs) {
    const source = sources.get(pair.source.originalSourceId),
      span = pair.originalSpan;
    requireValue(!pairIds.has(pair.id), "Duplicate review pair");
    pairIds.add(pair.id);
    requireValue(
      projectSplits[pair.split]?.includes(pair.projectId) &&
        source?.projectId === pair.projectId &&
        source.familyId === pair.familyId &&
        source.kind === "raw" &&
        pair.scope === "all",
      "Review project/split/original scope mismatch",
    );
    requireValue(
      pair.source.sha256 === source.sha256 &&
        pair.source.path === source.path &&
        pair.source.revision === source.revision &&
        pair.source.importedAt === source.importedAt &&
        pair.source.modifiedAt === source.modifiedAt,
      "Review original source metadata mismatch",
    );
    requireValue(
      /^[A-Za-z0-9_-]{1,64}$/.test(span.id) &&
        /^[A-Za-z0-9_-]{1,64}$/.test(pair.source.id),
      "Invalid app-style source/span ID",
    );
    requireValue(
      Number.isSafeInteger(span.startByte) &&
        Number.isSafeInteger(span.endByte) &&
        span.startByte >= 0 &&
        span.endByte > span.startByte &&
        span.endByte <= Buffer.byteLength(source.text),
      "Invalid original UTF-8 span bounds",
    );
    const bytes = Buffer.from(source.text).subarray(
      span.startByte,
      span.endByte,
    );
    requireValue(
      bytes.toString("utf8") === span.text &&
        sha256(bytes) === span.sha256 &&
        bytes.equals(Buffer.from(span.text)),
      "Original UTF-8 span/hash mismatch",
    );
    const marker =
      span.speakerRole === "user" ? "User request: " : "Assistant report: ";
    requireValue(
      ["user", "assistant"].includes(span.speakerRole) &&
        span.text.startsWith(`${span.turnTime} · ${marker}`) &&
        Number.isFinite(Date.parse(span.turnTime)),
      "Original speaker/time proof mismatch",
    );
    requireValue(
      pair.cases?.length === 2 &&
        pair.cases[0].variant === "source_supported" &&
        pair.cases[1].variant === "wrong_meaning",
      "Pair must contain both verdict variants",
    );
    requireValue(
      Object.hasOwn(mutationCounts, pair.mutationKind),
      "Unknown review mutation kind",
    );
    mutationCounts[pair.mutationKind] += 1;
    for (const entry of pair.cases) {
      requireValue(!caseIds.has(entry.id), "Duplicate review verdict case");
      caseIds.add(entry.id);
      const proposal = entry.proposal,
        claim = proposal?.claims?.[0];
      requireValue(
        proposal?.outcome === "claims" &&
          proposal.claims.length === 1 &&
          typeof claim.action === "string" &&
          claim.action.trim().length > 0 &&
          [...claim.action].length <= 512 &&
          claim.anchorSpanId === span.id &&
          encodeJson(claim.supportSpanIds) === encodeJson([span.id]) &&
          claim.actor.subjectSpanId === span.id &&
          claim.actor.basis === "explicit_subject" &&
          claim.eventTime.supportSpanId === span.id &&
          claim.verificationId === null,
        "Review proposal shape/support IDs invalid",
      );
      requireValue(
        entry.proposalSha256 === sha256(encodeJson(proposal)) &&
          entry.claimSha256 === sha256(encodeJson(claim)) &&
          entry.labelSha256 === sha256(encodeJson(entry.label)),
        "Review proposal/claim/label hash mismatch",
      );
      const supported = entry.variant === "source_supported";
      requireValue(
        entry.label.expectedVerdict === (supported ? "accept" : "reject") &&
          entry.label.critical === !supported &&
          entry.label.mutationKind === (supported ? null : pair.mutationKind) &&
          entry.label.reviewStatus === reviewStatus &&
          entry.label.provenance === artifact.provenance,
        "Review verdict label mismatch",
      );
    }
    requireValue(
      encodeJson(pair.cases[0].proposal) === encodeJson(proposalForSpan(span)),
      "Supported proposal no longer matches original turn",
    );
    const expectedWrong = structuredClone(pair.cases[0].proposal),
      wrongClaim = expectedWrong.claims[0];
    if (pair.mutationKind === "actor")
      wrongClaim.actor.role =
        span.speakerRole === "user" ? "assistant" : "user";
    if (pair.mutationKind === "action")
      wrongClaim.action = wrongClaim.action.replace(
        `synthetic-${pair.projectId}-feature-2`,
        `synthetic-${pair.projectId}-feature-99`,
      );
    if (pair.mutationKind === "eventTime")
      Object.assign(wrongClaim.eventTime, {
        value: source.importedAt,
        basis: "date_reference",
        uncertainty: "inferred",
      });
    if (pair.mutationKind === "status") wrongClaim.status = "reported_failed";
    requireValue(
      encodeJson(expectedWrong) === encodeJson(pair.cases[1].proposal) &&
        encodeJson(expectedWrong) !== encodeJson(pair.cases[0].proposal),
      "Wrong-meaning variant must change only its declared claim field",
    );
  }
  return { caseIds, mutationCounts };
}

async function readRegular(path) {
  const stat = await lstat(path);
  requireValue(
    stat.isFile() && !stat.isSymbolicLink(),
    "Review artifact must be a regular local file",
  );
  return readFile(path);
}

/** Load derived files while preserving and verifying the original frozen manifest. */
export async function loadAndValidateReview(root = fixtureRoot) {
  const base = await loadAndValidate(root);
  const manifestBytes = await readRegular(resolve(root, reviewManifestName));
  const manifest = JSON.parse(manifestBytes);
  requireValue(
    manifest.id === reviewId &&
      manifest.syntheticOnly === true &&
      manifest.labelStatus === "frozen_before_inference" &&
      manifest.semanticReviewStatus === reviewStatus,
    "Unexpected review manifest",
  );
  requireValue(
    manifest.base?.manifestSha256 === base.manifestSha256 &&
      encodeJson(manifest.base.artifacts) ===
        encodeJson(base.manifest.artifacts),
    "Frozen base manifest/hash references changed",
  );
  requireValue(
    manifest.artifact?.path === reviewArtifactName,
    "Unknown/unsafe review manifest artifact",
  );
  const artifactBytes = await readRegular(resolve(root, reviewArtifactName));
  requireValue(
    artifactBytes.length === manifest.artifact.bytes &&
      sha256(artifactBytes) === manifest.artifact.sha256,
    "Review artifact hash mismatch",
  );
  const artifact = JSON.parse(artifactBytes);
  const checks = validateReviewStructures(artifact, base);
  requireValue(
    encodeJson(manifest.counts) === encodeJson(artifact.counts),
    "Review manifest count mismatch",
  );
  return {
    base,
    manifest,
    manifestSha256: sha256(manifestBytes),
    artifact,
    checks,
  };
}
