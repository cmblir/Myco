import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  encodeJson,
  fixtureRoot,
  sha256,
} from "./local-wiki-eval-fixtures.mjs";
import { splits } from "./local-wiki-eval-validate.mjs";
import { roleNames } from "./local-wiki-eval-role-fixtures.mjs";
import { loadAndValidateRoles } from "./local-wiki-eval-role-validate.mjs";
import { scoreRoleResults } from "./local-wiki-eval-role-score.mjs";

export function parseRoleArguments(args) {
  const options = { split: "development", role: "all" },
    seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (
      !["--output", "--split", "--role", "--results"].includes(name) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(
        "Usage: local-wiki-eval-role-run.mjs --output /absolute/new-directory [--split development|calibration|held_out] [--role all|period_planner|reflect|semantic_lint|agent_proposals|audio_script] [--results /absolute/supplied-assessments.json]",
      );
    if (seen.has(name)) throw new Error("Duplicate role evaluation argument");
    seen.add(name);
    options[name.slice(2)] = value;
  }
  if (
    !options.output ||
    !isAbsolute(options.output) ||
    !splits.includes(options.split) ||
    (options.role !== "all" && !roleNames.includes(options.role)) ||
    (options.results && !isAbsolute(options.results))
  )
    throw new Error("Absolute output/results and valid role/split required");
  return options;
}

/** Validate source-bound role data and optional supplied assessments; never execute models or operations. */
export async function runRoles(options) {
  if (
    !splits.includes(options.split) ||
    (options.role !== "all" && !roleNames.includes(options.role)) ||
    !isAbsolute(options.output)
  )
    throw new Error("Invalid role-run selection/output");
  const parent = await realpath(dirname(options.output));
  const destination = resolve(parent, options.output.split(sep).at(-1)),
    frozenRoot = await realpath(fixtureRoot),
    within = relative(frozenRoot, destination);
  if (
    !within ||
    (!within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within))
  )
    throw new Error("Output cannot be inside the frozen corpus");
  await mkdir(destination);
  const tools = [];
  for (const filename of [
    "local-wiki-eval-fixtures.mjs",
    "local-wiki-eval-validate.mjs",
    ...[
      "fixtures",
      "cases",
      "validate",
      "score",
      "run",
      "test",
      "score-test",
      "test-support",
    ].map((name) => `local-wiki-eval-role-${name}.mjs`),
  ])
    tools.push({
      id: `app/scripts/${filename}`,
      sha256: sha256(
        await readFile(
          resolve(dirname(fileURLToPath(import.meta.url)), filename),
        ),
      ),
    });
  const receipt = {
    version: 1,
    kind: "role_fixture_or_supplied_assessments",
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    command: [
      "node",
      "app/scripts/local-wiki-eval-role-run.mjs",
      "--split",
      options.split,
      "--role",
      options.role,
      "--output",
      "<explicit-new-directory>",
      ...(options.results ? ["--results", "<explicit-supplied-file>"] : []),
    ],
    selection: { split: options.split, role: options.role, caseIds: [] },
    tools,
    fixtureStatus: "invalid",
    baseManifestSha256: null,
    configSha256: null,
    suiteManifestSha256: null,
    suiteArtifactSha256: null,
    caseSnapshots: [],
    tests: [],
    suppliedResultsSha256: null,
    score: null,
    model: null,
    inferenceExecuted: false,
    reviewPerformed: false,
    modelQuality: "not_evaluated",
    labelReviewStatus: "source_review_required",
    networkObservations: { attempted: null, blocked: null, successful: null },
  };
  try {
    const loaded = await loadAndValidateRoles();
    receipt.fixtureStatus = "valid";
    receipt.baseManifestSha256 = loaded.base.manifestSha256;
    receipt.configSha256 = loaded.base.manifest.artifacts.find(
      (entry) => entry.path === "config.json",
    ).sha256;
    receipt.suiteManifestSha256 = loaded.manifestSha256;
    receipt.suiteArtifactSha256 = loaded.manifest.artifact.sha256;
    const selected = loaded.artifact.cases.filter(
      (entry) =>
        entry.split === options.split &&
        (options.role === "all" || entry.role === options.role),
    );
    receipt.selection.caseIds = selected.map((entry) => entry.id);
    receipt.caseSnapshots = selected.map((entry) => ({
      caseId: entry.id,
      caseSha256: entry.caseSha256,
      sourcePacketSha256: entry.sourcePacketSha256,
      labelSha256: entry.labelSha256,
      sourceSnapshots: entry.sourcePackets.map((packet) => ({
        originalSourceId: packet.originalSourceId,
        sha256: packet.sha256,
        spans: packet.spans.map(({ id, sha256 }) => ({ id, sha256 })),
      })),
    }));
    receipt.tests = loaded.checks.map((name) => ({ name, status: "passed" }));
    if (options.results) {
      const stat = await lstat(options.results);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4 * 1024 * 1024
      )
        throw new Error("Role results must be a bounded regular local file");
      const bytes = await readFile(options.results);
      receipt.suppliedResultsSha256 = sha256(bytes);
      let results;
      try {
        results = JSON.parse(bytes);
      } catch {
        throw new Error("Supplied role assessments must be valid JSON");
      }
      receipt.score = scoreRoleResults(loaded, results, options);
      receipt.tests.push({
        name: "supplied assessments identity and per-role scheduled denominator",
        status: "passed",
      });
    }
  } catch (error) {
    receipt.tests.push({
      name: "role fixtures/supplied assessments validation",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  receipt.finishedAt = new Date().toISOString();
  const path = resolve(destination, "receipt.json");
  await writeFile(path, encodeJson(receipt), { flag: "wx" });
  return {
    path,
    receipt,
    valid:
      receipt.fixtureStatus === "valid" &&
      receipt.tests.every((entry) => entry.status === "passed"),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { path, receipt, valid } = await runRoles(
      parseRoleArguments(process.argv.slice(2)),
    );
    console.log(
      JSON.stringify({
        receipt: path,
        fixtureStatus: receipt.fixtureStatus,
        validationStatus: valid ? "passed" : "failed",
        validationFailures: receipt.tests.filter(
          (entry) => entry.status === "failed",
        ),
        selectedCases: receipt.selection.caseIds.length,
        referenceGatesMet: receipt.score?.referenceGatesMet ?? null,
        inferenceExecuted: false,
        reviewPerformed: false,
        modelQuality: "not_evaluated",
        labelReviewStatus: "source_review_required",
      }),
    );
    if (!valid || (receipt.score && !receipt.score.referenceGatesMet))
      process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
