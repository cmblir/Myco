import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  encodeJson,
  fixtureRoot,
  sha256,
} from "./local-wiki-eval-fixtures.mjs";
import { loadAndValidate, splits } from "./local-wiki-eval-validate.mjs";
import {
  buildRoleFixtures,
  roleArtifactName,
  roleManifestName,
  roleNames,
  roleSuiteId,
} from "./local-wiki-eval-role-fixtures.mjs";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** Verify derived contracts and verbatim originals; this is not role/model execution. */
export function validateRoleStructures(artifact, base) {
  requireValue(
    artifact.id === roleSuiteId &&
      artifact.syntheticOnly === true &&
      artifact.baseManifestSha256 === base.manifestSha256,
    "Role/base identity mismatch",
  );
  requireValue(
    artifact.labelStatus === "frozen_before_inference" &&
      artifact.semanticReviewStatus === "source_review_required" &&
      artifact.provenance ===
        "deterministic_synthetic_reference_not_human_reviewed",
    "Role labels must remain source-review-required",
  );
  requireValue(
    artifact.cases?.length === 200,
    "Expected 200 derived role cases",
  );
  const sources = new Map(
    base.files["corpus.json"].sources.map((source) => [source.id, source]),
  );
  const seen = new Set();
  for (const entry of artifact.cases) {
    requireValue(!seen.has(entry.id), "Duplicate derived role case");
    seen.add(entry.id);
    requireValue(
      roleNames.includes(entry.role) &&
        base.files["config.json"].splits[entry.split]?.includes(
          entry.projectId,
        ) &&
        entry.scope === "all",
      "Role/project split or scope mismatch",
    );
    const { caseSha256, sourcePacketSha256, label, labelSha256, ...content } =
      entry;
    requireValue(
      caseSha256 === sha256(encodeJson(content)) &&
        sourcePacketSha256 === sha256(encodeJson(entry.sourcePackets)) &&
        labelSha256 === sha256(encodeJson(label)),
      "Role case/source/label hash mismatch",
    );
    requireValue(
      label.reviewStatus === "source_review_required" &&
        label.provenance === artifact.provenance &&
        label.positiveResponseRequired === true &&
        label.critical === true,
      "Role label/critical response contract mismatch",
    );
    const spanIds = new Set();
    for (const packet of entry.sourcePackets) {
      const source = sources.get(packet.originalSourceId);
      requireValue(
        source?.projectId === entry.projectId &&
          source.familyId === packet.familyId &&
          source.path === packet.path &&
          source.sha256 === packet.sha256 &&
          source.kind === packet.kind &&
          (source.revision ?? null) === packet.revision &&
          (source.importedAt ?? null) === packet.importedAt &&
          (source.modifiedAt ?? null) === packet.modifiedAt,
        "Role original source identity/metadata mismatch",
      );
      requireValue(
        /^[A-Za-z0-9_-]{1,64}$/.test(packet.sourceId),
        "Invalid role source ID",
      );
      for (const span of packet.spans) {
        requireValue(
          !spanIds.has(span.id) && /^[A-Za-z0-9_-]{1,64}$/.test(span.id),
          "Duplicate/invalid role span ID",
        );
        spanIds.add(span.id);
        requireValue(
          Number.isSafeInteger(span.startByte) &&
            Number.isSafeInteger(span.endByte) &&
            span.startByte >= 0 &&
            span.endByte > span.startByte &&
            span.endByte <= Buffer.byteLength(source.text),
          "Invalid role original byte bounds",
        );
        const bytes = Buffer.from(source.text).subarray(
          span.startByte,
          span.endByte,
        );
        requireValue(
          bytes.equals(Buffer.from(span.text)) && sha256(bytes) === span.sha256,
          "Role original UTF-8 span/hash mismatch",
        );
        const originalTime =
          span.text.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)?.[0] ?? null;
        requireValue(
          span.turnTime === originalTime &&
            (span.turnTime === null ||
              Date.parse(span.turnTime) <= Date.parse(entry.capturedQueryTime)),
          "Role original time/as-of mismatch",
        );
        const originalSpeaker = span.text.includes(" · User ")
          ? "user"
          : span.text.includes(" · Assistant ")
            ? "assistant"
            : "source";
        requireValue(
          span.speakerRole === originalSpeaker,
          "Role original speaker mismatch",
        );
        requireValue(
          packet.independentOriginalWorkEvidence ===
            (source.kind === "raw" &&
              span.proofPurpose === "original_work_evidence"),
          "Coordination/injection cannot become independent work evidence",
        );
      }
    }
    for (const fact of label.requiredFacts)
      requireValue(
        fact.independentVerification === false &&
          fact.supportSpanIds.length > 0 &&
          fact.supportSpanIds.every((id) => spanIds.has(id)),
        "Required role fact lacks original support or invents canonical verification",
      );
    if (entry.role === "agent_proposals" && entry.input.target) {
      const target = sources.get(`${entry.projectId}:map`);
      requireValue(
        entry.input.target.path === target.path &&
          entry.input.target.sha256 === target.sha256 &&
          entry.input.target.content === target.text &&
          entry.input.nativeAuthority === "not_issued_in_fixture",
        "Agent target fixture is not native authority",
      );
    }
  }
  for (const role of roleNames) {
    requireValue(
      artifact.cases.filter((entry) => entry.role === role).length === 40,
      "Expected 40 cases per additional role",
    );
    for (const [split, count] of [
      ["development", 16],
      ["calibration", 8],
      ["held_out", 16],
    ]) {
      requireValue(
        artifact.cases.filter(
          (entry) => entry.role === role && entry.split === split,
        ).length === count,
        "Role split case count mismatch",
      );
      for (const projectId of base.files["config.json"].splits[split])
        requireValue(
          artifact.cases.filter(
            (entry) =>
              entry.role === role &&
              entry.projectId === projectId &&
              entry.split === split,
          ).length === 2,
          "Role project grouping mismatch",
        );
    }
    const repeated = artifact.criticalRepeats.perRoleCaseIds[role];
    requireValue(
      repeated.length === 8 &&
        new Set(repeated).size === 8 &&
        repeated.every((id) =>
          artifact.cases.some(
            (entry) =>
              entry.id === id &&
              entry.role === role &&
              entry.split === "held_out" &&
              entry.label.critical,
          ),
        ),
      "Role critical repeats outside fixed held-out projects",
    );
  }
  requireValue(
    splits.every(
      (split) =>
        encodeJson(artifact.projectSplits[split]) ===
        encodeJson(base.files["config.json"].splits[split]),
    ),
    "Role grouped split changed",
  );
  requireValue(
    encodeJson(artifact) === encodeJson(buildRoleFixtures(base)),
    "Role artifact differs from deterministic source-bound derivation",
  );
  return [
    "unchanged frozen base identity",
    "five role counts/project-held-out grouping",
    "original UTF-8 actor/time/span proofs",
    "proposals and injection separated from original work",
    "unreviewed labels and unexecuted critical repeats",
  ];
}

async function regularBytes(path) {
  const stat = await lstat(path);
  requireValue(
    stat.isFile() && !stat.isSymbolicLink(),
    "Role artifact must be a regular local file",
  );
  return readFile(path);
}

export async function loadAndValidateRoles(root = fixtureRoot) {
  const base = await loadAndValidate(root);
  const manifestBytes = await regularBytes(resolve(root, roleManifestName)),
    manifest = JSON.parse(manifestBytes);
  requireValue(
    manifest.id === roleSuiteId &&
      manifest.syntheticOnly === true &&
      manifest.labelStatus === "frozen_before_inference" &&
      manifest.semanticReviewStatus === "source_review_required",
    "Unexpected role manifest",
  );
  requireValue(
    manifest.base.manifestSha256 === base.manifestSha256 &&
      encodeJson(manifest.base.artifacts) ===
        encodeJson(base.manifest.artifacts),
    "Role frozen base references changed",
  );
  requireValue(
    manifest.artifact.path === roleArtifactName,
    "Unknown/unsafe role manifest artifact",
  );
  const artifactBytes = await regularBytes(resolve(root, roleArtifactName));
  requireValue(
    artifactBytes.length === manifest.artifact.bytes &&
      sha256(artifactBytes) === manifest.artifact.sha256,
    "Role artifact hash mismatch",
  );
  const artifact = JSON.parse(artifactBytes),
    checks = validateRoleStructures(artifact, base);
  requireValue(
    encodeJson(manifest.counts) === encodeJson(artifact.counts),
    "Role manifest counts mismatch",
  );
  return {
    base,
    manifest,
    manifestSha256: sha256(manifestBytes),
    artifact,
    checks,
  };
}
