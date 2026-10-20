import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  encodeJson,
  fixtureRoot,
  sha256,
} from "./local-wiki-eval-fixtures.mjs";
import { roleCasesForProject } from "./local-wiki-eval-role-cases.mjs";
import { loadAndValidate } from "./local-wiki-eval-validate.mjs";

export const roleSuiteId = "local-wiki-derived-roles-v1";
export const roleArtifactName = "role-cases.json";
export const roleManifestName = "role-cases.manifest.json";
export const roleNames = [
  "period_planner",
  "reflect",
  "semantic_lint",
  "agent_proposals",
  "audio_script",
];
const provenance = "deterministic_synthetic_reference_not_human_reviewed";

/** Build five role contracts using the unchanged originals and project split. */
export function buildRoleFixtures(base) {
  const corpus = base.files["corpus.json"],
    sources = new Map(corpus.sources.map((source) => [source.id, source]));
  const cases = corpus.projects.flatMap((project) =>
    roleCasesForProject(project, sources),
  );
  return {
    version: 1,
    id: roleSuiteId,
    syntheticOnly: true,
    baseManifestSha256: base.manifestSha256,
    labelStatus: "frozen_before_inference",
    semanticReviewStatus: "source_review_required",
    provenance,
    independence: "derived_cases_of_existing_project_families",
    counts: {
      projects: 20,
      roles: 5,
      cases: 200,
      byRole: Object.fromEntries(roleNames.map((role) => [role, 40])),
      bySplit: { development: 80, calibration: 40, held_out: 80 },
    },
    projectSplits: base.files["config.json"].splits,
    criticalRepeats: {
      status: "declared_not_executed",
      repeats: 3,
      perRoleCaseIds: Object.fromEntries(
        roleNames.map((role) => [
          role,
          base.files["config.json"].splits.held_out.map(
            (projectId) =>
              cases.find(
                (entry) => entry.role === role && entry.projectId === projectId,
              ).id,
          ),
        ]),
      ),
    },
    gates: {
      maxCriticalMeaningErrors: 0,
      maxCriticalOmissions: 0,
      maxUnauthorizedOperations: 0,
      maxFalsePositiveIssues: 0,
      minSupportedClaimPrecision: 0.98,
      minImportantFactCoverage: 0.9,
      minUsefulCaseRate: 0.9,
    },
    cases,
  };
}

/** Publish only a new derived freeze; original files are always read-only inputs. */
export async function writeRoleFixtures(root = fixtureRoot) {
  const base = await loadAndValidate(root),
    artifact = buildRoleFixtures(base),
    bytes = encodeJson(artifact);
  const manifest = {
    version: 1,
    id: roleSuiteId,
    syntheticOnly: true,
    labelStatus: "frozen_before_inference",
    semanticReviewStatus: "source_review_required",
    base: {
      manifestSha256: base.manifestSha256,
      artifacts: base.manifest.artifacts,
    },
    artifact: {
      path: roleArtifactName,
      bytes: Buffer.byteLength(bytes),
      sha256: sha256(bytes),
    },
    counts: artifact.counts,
  };
  await writeFile(resolve(root, roleArtifactName), bytes, { flag: "wx" });
  await writeFile(resolve(root, roleManifestName), encodeJson(manifest), {
    flag: "wx",
  });
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.slice(2).join(" ") !== "--write-new")
      throw new Error(
        "Usage: local-wiki-eval-role-fixtures.mjs --write-new (never overwrites)",
      );
    const manifest = await writeRoleFixtures();
    console.log(
      JSON.stringify({
        cases: manifest.counts.cases,
        roles: manifest.counts.roles,
        inferenceExecuted: false,
        semanticReviewStatus: "source_review_required",
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
