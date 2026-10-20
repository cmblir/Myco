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
import { loadAndValidateReview } from "./local-wiki-eval-review-validate.mjs";
import { scoreReviewResults } from "./local-wiki-eval-review-score.mjs";
import { reviewStatus } from "./local-wiki-eval-review-fixtures.mjs";
import { loadReviewBundle, reviewSnapshots } from "./local-wiki-eval-review-bundle.mjs";

export function parseReviewArguments(args) {
  const options = { split: "development" };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (
      !["--output", "--split", "--results", "--bundle", "--bundle-sha256"].includes(name) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(
        "Usage: local-wiki-eval-review-run.mjs --output /absolute/new-directory [--split development|calibration|held_out] [--results /absolute/supplied-verdicts.json] [--bundle /absolute/bundle.json --bundle-sha256 FROZEN_SHA256]",
      );
    if (seen.has(name)) throw new Error("Duplicate review argument");
    seen.add(name);
    options[name === "--bundle-sha256" ? "bundleSha256" : name.slice(2)] = value;
  }
  if (
    !options.output ||
    !isAbsolute(options.output) ||
    !splits.includes(options.split) ||
    (options.results && !isAbsolute(options.results))
  )
    throw new Error("Absolute output/results and valid split are required");
  validateBundleOptions(options);
  return options;
}

function validateBundleOptions(options) {
  if ((options.bundle === undefined) !== (options.bundleSha256 === undefined) ||
    (options.bundle !== undefined && (!isAbsolute(options.bundle) ||
      !/^[a-f0-9]{64}$/.test(options.bundleSha256))))
    throw new Error("An absolute bundle and its frozen SHA256 are both required");
}

async function newOutput(output, bundle) {
  if (!isAbsolute(output)) throw new Error("Output must be absolute");
  const parent = await realpath(dirname(output));
  const destination = resolve(parent, output.split(sep).at(-1));
  const frozenRoot = await realpath(fixtureRoot);
  const within = relative(frozenRoot, destination);
  if (
    !within ||
    (!within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within))
  )
    throw new Error("Output cannot be inside the frozen corpus");
  if (bundle) {
    const withinBundle = relative(dirname(bundle), destination);
    if (!withinBundle || (!withinBundle.startsWith(`..${sep}`) &&
      withinBundle !== ".." && !isAbsolute(withinBundle)))
      throw new Error("Output cannot be inside the frozen bundle");
  }
  await mkdir(destination);
  return destination;
}

/** Read synthetic artifacts and optionally aggregate supplied verdicts, without running inference. */
export async function runReview(options) {
  if (!splits.includes(options.split)) throw new Error("Unknown review split");
  validateBundleOptions(options);
  const startedAt = new Date().toISOString();
  const output = await newOutput(options.output, options.bundle);
  const tools = [];
  for (const filename of [
    "local-wiki-eval-fixtures.mjs",
    "local-wiki-eval-validate.mjs",
    ...["fixtures", "validate", "score", "run", "test"].map(
      (name) => `local-wiki-eval-review-${name}.mjs`,
    ),
    ...(options.bundle ? ["local-wiki-eval-review-bundle.mjs", "local-wiki-eval-review-bundle-test.mjs"] : []),
  ]) {
    const id = `app/scripts/${filename}`;
    tools.push({
      id,
      sha256: sha256(
        await readFile(
          resolve(dirname(fileURLToPath(import.meta.url)), filename),
        ),
      ),
    });
  }
  const receipt = {
    version: 1,
    kind: "review_fixture_or_supplied_verdicts",
    runId: randomUUID(),
    startedAt,
    finishedAt: null,
    command: [
      "node",
      "app/scripts/local-wiki-eval-review-run.mjs",
      "--split",
      options.split,
      "--output",
      "<explicit-new-directory>",
      ...(options.results ? ["--results", "<explicit-supplied-file>"] : []),
      ...(options.bundle ? ["--bundle", "<explicit-frozen-bundle>",
        "--bundle-sha256", options.bundleSha256] : []),
    ],
    split: options.split,
    inputReadScope: options.bundle ? "frozen_split_bundle" : "whole_corpus_before_split",
    bundle: null,
    tools,
    fixtureStatus: "invalid",
    baseManifestSha256: null,
    configSha256: null,
    suiteManifestSha256: null,
    suiteArtifactSha256: null,
    sourceSnapshots: [],
    tests: [],
    suppliedResultsSha256: null,
    score: null,
    model: null,
    inferenceExecuted: false,
    modelQuality: "not_evaluated",
    labelReviewStatus: reviewStatus,
    networkObservations: { attempted: null, blocked: null, successful: null },
  };
  try {
    const loaded = options.bundle
      ? await loadReviewBundle(options.bundle, options.bundleSha256, options.split)
      : await loadAndValidateReview();
    receipt.fixtureStatus = "valid";
    receipt.bundle = loaded.bundle ?? null;
    Object.assign(receipt, loaded.bundle?.parent ?? {
      baseManifestSha256: loaded.base.manifestSha256,
      configSha256: loaded.base.manifest.artifacts.find(
        (entry) => entry.path === "config.json",
      ).sha256,
      suiteManifestSha256: loaded.manifestSha256,
      suiteArtifactSha256: loaded.manifest.artifact.sha256,
    });
    receipt.sourceSnapshots = reviewSnapshots(
      loaded.artifact.pairs.filter((pair) => pair.split === options.split),
    );
    receipt.tests = loaded.checks.map((name) => ({ name, status: "passed" }));
    if (options.results) {
      const stat = await lstat(options.results);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 2 * 1024 * 1024
      )
        throw new Error(
          "Supplied results must be a bounded regular local file",
        );
      const bytes = await readFile(options.results);
      receipt.suppliedResultsSha256 = sha256(bytes);
      let results;
      try {
        results = JSON.parse(bytes);
      } catch {
        throw new Error("Supplied review results must be valid JSON");
      }
      receipt.score = scoreReviewResults(loaded, results, options.split);
      receipt.tests.push({
        name: "supplied verdict identity and scheduled denominator",
        status: "passed",
      });
    }
  } catch (error) {
    receipt.tests.push({
      name: "review fixture/supplied results validation",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  receipt.finishedAt = new Date().toISOString();
  const path = resolve(output, "receipt.json");
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
    const { path, receipt, valid } = await runReview(
      parseReviewArguments(process.argv.slice(2)),
    );
    console.log(
      JSON.stringify({
        receipt: path,
        fixtureStatus: receipt.fixtureStatus,
        validationStatus: valid ? "passed" : "failed",
        validationFailures: receipt.tests.filter(
          (entry) => entry.status === "failed",
        ),
        selectedPairs: receipt.sourceSnapshots.length,
        referenceGatesMet: receipt.score?.referenceGatesMet ?? null,
        inferenceExecuted: false,
        modelQuality: "not_evaluated",
        labelReviewStatus: reviewStatus,
        inputReadScope: receipt.inputReadScope,
      }),
    );
    if (!valid || (receipt.score && !receipt.score.referenceGatesMet))
      process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
