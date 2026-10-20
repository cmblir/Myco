import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadAndValidate,
  splits,
  suites,
} from "./local-wiki-eval-validate.mjs";
import { writeReceipt } from "./local-wiki-eval-receipt.mjs";
import { sha256 } from "./local-wiki-eval-fixtures.mjs";

export function parseArguments(args) {
  const options = { split: "development", suite: "all" };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (
      !["--split", "--suite", "--output"].includes(name) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(
        "Usage: local-wiki-eval-run.mjs --output /absolute/new-directory [--split development|calibration|held_out] [--suite all|retrieval|ask|compilation|maps|study|resurface]",
      );
    if (Object.hasOwn(options, name.slice(2)) && options[`${name}:seen`])
      throw new Error("Duplicate evaluation argument");
    options[name.slice(2)] = value;
    options[`${name}:seen`] = true;
  }
  if (
    !options.output ||
    !splits.includes(options.split) ||
    (options.suite !== "all" && !suites.includes(options.suite))
  )
    throw new Error("Explicit output and valid split/suite are required");
  return { split: options.split, suite: options.suite, output: options.output };
}

/** Run deterministic integrity checks only; no model, connector, or user vault. */
export async function runIntegrity(options) {
  const startedAt = new Date().toISOString();
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const sourceTreeDirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    }).trim().length > 0;
  const toolSnapshots = [];
  for (const file of ["fixtures", "validate", "receipt", "run", "test"]) {
    const id = `app/scripts/local-wiki-eval-${file}.mjs`;
    toolSnapshots.push({
      id,
      sha256: sha256(await readFile(resolve(repo, id))),
    });
  }
  const receipt = {
    version: 1,
    kind: "fixture_integrity",
    runId: randomUUID(),
    startedAt,
    finishedAt: null,
    sourceCommit: commit,
    sourceTreeDirty,
    toolSnapshots,
    command: [
      "node",
      "app/scripts/local-wiki-eval-run.mjs",
      "--split",
      options.split,
      "--suite",
      options.suite,
      "--output",
      "<explicit-new-directory>",
    ],
    fixtureStatus: "invalid",
    model: null,
    inferenceExecuted: false,
    modelQuality: "not_evaluated",
    selection: { split: options.split, suite: options.suite, caseIds: [] },
    manifestSha256: null,
    configSha256: null,
    sourceSnapshots: [],
    tests: [],
    networkObservations: { attempted: null, blocked: null, successful: null },
  };
  try {
    const result = await loadAndValidate();
    const selectedProjects = new Set(
      result.files["config.json"].splits[options.split],
    );
    receipt.selection.caseIds = result.files["queries.json"].cases
      .filter(
        (entry) =>
          entry.split === options.split &&
          (options.suite === "all" || entry.suite === options.suite),
      )
      .map((entry) => entry.id);
    receipt.sourceSnapshots = result.files["corpus.json"].sources
      .filter((entry) => selectedProjects.has(entry.projectId))
      .map(({ id, sha256 }) => ({ id, sha256 }));
    receipt.manifestSha256 = result.manifestSha256;
    receipt.configSha256 = result.manifest.artifacts.find(
      (entry) => entry.path === "config.json",
    ).sha256;
    receipt.tests = result.checks.map((name) => ({ name, status: "passed" }));
    receipt.fixtureStatus = "valid";
  } catch (error) {
    receipt.tests = [
      {
        name: "frozen fixture contract",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  receipt.finishedAt = new Date().toISOString();
  const path = await writeReceipt(options.output, receipt);
  return { path, receipt };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { path, receipt } = await runIntegrity(
      parseArguments(process.argv.slice(2)),
    );
    console.log(
      JSON.stringify({
        receipt: path,
        fixtureStatus: receipt.fixtureStatus,
        selectedCases: receipt.selection.caseIds.length,
        inferenceExecuted: false,
        modelQuality: "not_evaluated",
      }),
    );
    if (receipt.fixtureStatus !== "valid") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
