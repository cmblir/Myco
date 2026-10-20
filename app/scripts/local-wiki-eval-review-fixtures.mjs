import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  encodeJson,
  fixtureRoot,
  sha256,
} from "./local-wiki-eval-fixtures.mjs";
import { loadAndValidate } from "./local-wiki-eval-validate.mjs";

export const reviewId = "local-wiki-review-pairs-v1";
export const reviewArtifactName = "review-pairs.json";
export const reviewManifestName = "review-pairs.manifest.json";
export const reviewStatus = "source_review_required";

/** Derive a bounded claim from a verbatim synthetic original turn, not its projection. */
export function proposalForSpan(span) {
  const marker =
    span.speakerRole === "user" ? "User request: " : "Assistant report: ";
  const action = span.text.split(marker)[1];
  if (!action || action.length > 512)
    throw new Error("Missing bounded original action");
  return {
    outcome: "claims",
    claims: [
      {
        action,
        anchorSpanId: span.id,
        supportSpanIds: [span.id],
        actor: {
          role: span.speakerRole,
          basis: "explicit_subject",
          subjectSpanId: span.id,
        },
        eventTime: {
          value: span.turnTime,
          basis: "explicit",
          precision: "instant",
          uncertainty: "specified",
          supportSpanId: span.id,
        },
        speechAct: span.speakerRole === "user" ? "request" : "report",
        status:
          span.speakerRole === "user" ? "requested" : "reported_completed",
        verificationId: null,
      },
    ],
  };
}

function originalSpan(source, speakerRole) {
  const marker =
    speakerRole === "user" ? "User request: " : "Assistant report: ";
  const lines = source.text.split("\n");
  const line = lines.find((entry) => entry.includes(` · ${marker}`));
  if (!line)
    throw new Error(`Missing original ${speakerRole} turn: ${source.id}`);
  const offset = source.text.indexOf(line);
  const startByte = Buffer.byteLength(source.text.slice(0, offset));
  return {
    id: `span_${source.id.replaceAll(":", "_")}_${speakerRole}`,
    speakerRole,
    turnTime: line.split(" · ")[0],
    startByte,
    endByte: startByte + Buffer.byteLength(line),
    text: line,
    sha256: sha256(line),
  };
}

function mutatedProposal(reference, source, mutationKind) {
  const proposal = structuredClone(reference);
  const claim = proposal.claims[0];
  if (mutationKind === "actor") {
    claim.actor.role = claim.actor.role === "user" ? "assistant" : "user";
  } else if (mutationKind === "action") {
    const feature = `synthetic-${source.projectId}-feature-2`;
    if (!claim.action.includes(feature))
      throw new Error("Original feature absent");
    claim.action = claim.action.replace(
      feature,
      `synthetic-${source.projectId}-feature-99`,
    );
    if (source.text.includes(`synthetic-${source.projectId}-feature-99`))
      throw new Error("Mutated action is already present in its original");
  } else if (mutationKind === "eventTime") {
    claim.eventTime.value = source.importedAt;
    claim.eventTime.basis = "date_reference";
    claim.eventTime.uncertainty = "inferred";
    if (source.text.includes(source.importedAt))
      throw new Error("Import date is original evidence");
  } else if (mutationKind === "status") {
    claim.status = "reported_failed";
  } else throw new Error("Unknown review mutation");
  return proposal;
}

function verdictCase(pairId, proposal, mutationKind, isSupported) {
  const label = {
    expectedVerdict: isSupported ? "accept" : "reject",
    critical: !isSupported,
    mutationKind: isSupported ? null : mutationKind,
    reviewStatus,
    provenance: "deterministic_synthetic_reference_not_human_reviewed",
  };
  return {
    id: `${pairId}:${isSupported ? "supported" : "wrong_meaning"}`,
    variant: isSupported ? "source_supported" : "wrong_meaning",
    proposal,
    proposalSha256: sha256(encodeJson(proposal)),
    claimSha256: sha256(encodeJson(proposal.claims[0])),
    label,
    labelSha256: sha256(encodeJson(label)),
  };
}

/** Reuse frozen projects and originals; derived variants are not independent families. */
export function buildReviewFixtures(base) {
  const corpus = base.files["corpus.json"];
  const sources = new Map(corpus.sources.map((source) => [source.id, source]));
  const pairs = [];
  for (const [index, project] of corpus.projects.entries()) {
    const oddProject = index % 2 === 0;
    for (const [timeline, revision, speakerRole, mutationKind] of [
      ["t1", 1, "user", oddProject ? "actor" : "eventTime"],
      ["t2", 2, "assistant", oddProject ? "action" : "status"],
    ]) {
      const source = sources.get(`${project.id}:${timeline}:r${revision}`);
      if (!source || source.kind !== "raw")
        throw new Error("Missing original review source");
      const span = originalSpan(source, speakerRole);
      const proposal = proposalForSpan(span);
      const pairId = `review:${project.id}:${timeline}`;
      pairs.push({
        id: pairId,
        projectId: project.id,
        familyId: source.familyId,
        split: project.split,
        scope: "all",
        mutationKind,
        source: {
          id: `source_${source.id.replaceAll(":", "_")}`,
          originalSourceId: source.id,
          path: source.path,
          sha256: source.sha256,
          revision: source.revision,
          kind: source.kind,
          importedAt: source.importedAt,
          modifiedAt: source.modifiedAt,
        },
        originalSpan: span,
        cases: [
          verdictCase(pairId, proposal, mutationKind, true),
          verdictCase(
            pairId,
            mutatedProposal(proposal, source, mutationKind),
            mutationKind,
            false,
          ),
        ],
      });
    }
  }
  return {
    version: 1,
    id: reviewId,
    suite: "internal_meaning_review",
    syntheticOnly: true,
    baseManifestSha256: base.manifestSha256,
    labelStatus: "frozen_before_inference",
    semanticReviewStatus: reviewStatus,
    provenance: "deterministic_synthetic_reference_not_human_reviewed",
    independence: "paired_variants_of_existing_project_families",
    counts: {
      projects: 20,
      pairs: 40,
      verdictCases: 80,
      mutations: { actor: 10, action: 10, eventTime: 10, status: 10 },
    },
    splits: Object.fromEntries(
      Object.entries(base.files["config.json"].splits).map(
        ([split, projectIds]) => [
          split,
          {
            projectIds,
            pairIds: pairs
              .filter((pair) => pair.split === split)
              .map((pair) => pair.id),
          },
        ],
      ),
    ),
    gates: {
      maxCriticalWrongMeaningAcceptance: 0,
      minCorrectProposalAcceptance: 0.9,
      requiresAllIncorrectVerdicts: true,
    },
    pairs,
  };
}

/** Publish new derived files only; never regenerate the original six artifacts. */
export async function writeReviewFixtures(root = fixtureRoot) {
  const base = await loadAndValidate(root);
  const artifact = buildReviewFixtures(base);
  const bytes = encodeJson(artifact);
  const manifest = {
    version: 1,
    id: reviewId,
    syntheticOnly: true,
    labelStatus: "frozen_before_inference",
    semanticReviewStatus: reviewStatus,
    base: {
      manifestSha256: base.manifestSha256,
      artifacts: base.manifest.artifacts,
    },
    artifact: {
      path: reviewArtifactName,
      bytes: Buffer.byteLength(bytes),
      sha256: sha256(bytes),
    },
    counts: artifact.counts,
  };
  await writeFile(resolve(root, reviewArtifactName), bytes, { flag: "wx" });
  await writeFile(resolve(root, reviewManifestName), encodeJson(manifest), {
    flag: "wx",
  });
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.slice(2).join(" ") !== "--write-new") {
    console.error(
      "Usage: local-wiki-eval-review-fixtures.mjs --write-new (never overwrites)",
    );
    process.exitCode = 1;
  } else {
    try {
      const manifest = await writeReviewFixtures();
      console.log(
        JSON.stringify({
          pairs: manifest.counts.pairs,
          verdictCases: manifest.counts.verdictCases,
          semanticReviewStatus: reviewStatus,
          inferenceExecuted: false,
        }),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
