import { link, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  fixtureRoot,
  encodeJson,
  sha256,
} from "./local-wiki-eval-fixtures.mjs";

const digest = /^[a-f0-9]{64}$/;
/** Validate W00 integrity receipts; semantic/inference acceptance is out of scope. */
export function validateReceipt(receipt) {
  const fail = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const keys = [
    "version",
    "kind",
    "runId",
    "startedAt",
    "finishedAt",
    "sourceCommit",
    "sourceTreeDirty",
    "toolSnapshots",
    "command",
    "fixtureStatus",
    "model",
    "inferenceExecuted",
    "modelQuality",
    "selection",
    "manifestSha256",
    "configSha256",
    "sourceSnapshots",
    "tests",
    "networkObservations",
  ];
  fail(
    Object.keys(receipt).length === keys.length &&
      keys.every((key) => Object.hasOwn(receipt, key)),
    "Unexpected or missing receipt field",
  );
  fail(
    receipt.version === 1 && receipt.kind === "fixture_integrity",
    "Unsupported receipt kind/version",
  );
  fail(
    /^[a-f0-9]{40}$/.test(receipt.sourceCommit) &&
      typeof receipt.sourceTreeDirty === "boolean",
    "Source revision/state missing",
  );
  fail(
    /^[a-f0-9-]{36}$/.test(receipt.runId) &&
      Number.isFinite(Date.parse(receipt.startedAt)) &&
      Number.isFinite(Date.parse(receipt.finishedAt)) &&
      receipt.startedAt <= receipt.finishedAt,
    "Run identity/timing missing",
  );
  fail(
    receipt.command.length > 0 &&
      receipt.command.every((entry) => typeof entry === "string"),
    "Command receipt missing",
  );
  fail(
    receipt.inferenceExecuted === false &&
      receipt.model === null &&
      receipt.modelQuality === "not_evaluated",
    "Integrity receipts cannot assert inference or model quality",
  );
  fail(
    ["development", "calibration", "held_out"].includes(
      receipt.selection.split,
    ),
    "Receipt split missing",
  );
  fail(
    [
      "all",
      "retrieval",
      "ask",
      "compilation",
      "maps",
      "study",
      "resurface",
    ].includes(receipt.selection.suite),
    "Receipt suite missing",
  );
  fail(
    receipt.selection.caseIds.length ===
      new Set(receipt.selection.caseIds).size,
    "Duplicate receipt case",
  );
  fail(
    ["valid", "invalid"].includes(receipt.fixtureStatus),
    "Unknown fixture status",
  );
  fail(
    receipt.tests.length > 0 &&
      receipt.tests.every((entry) =>
        ["passed", "failed"].includes(entry.status),
      ),
    "Receipt tests missing",
  );
  fail(
    receipt.fixtureStatus !== "valid" ||
      receipt.tests.every((entry) => entry.status === "passed"),
    "Failed fixture cannot report valid",
  );
  fail(
    receipt.fixtureStatus !== "invalid" ||
      receipt.tests.some((entry) => entry.status === "failed"),
    "Invalid fixture must retain failure",
  );
  fail(
    receipt.fixtureStatus !== "valid" ||
      (digest.test(receipt.manifestSha256) &&
        digest.test(receipt.configSha256) &&
        receipt.sourceSnapshots.length > 0 &&
        receipt.selection.caseIds.length > 0),
    "Valid receipt requires source/config/manifest/case identity",
  );
  for (const collection of [receipt.sourceSnapshots, receipt.toolSnapshots]) {
    fail(
      new Set(collection.map((entry) => entry.id)).size === collection.length,
      "Duplicate snapshot identity",
    );
    for (const snapshot of collection)
      fail(
        typeof snapshot.id === "string" && digest.test(snapshot.sha256),
        "Invalid snapshot hash",
      );
  }
  fail(receipt.toolSnapshots.length > 0, "Tool code hashes missing");
  fail(
    Object.values(receipt.networkObservations).every((value) => value === null),
    "W00 does not measure process egress",
  );
  return receipt;
}

/** Publish into a new explicit directory without overwriting prior receipts. */
export async function writeReceipt(directory, receipt) {
  validateReceipt(receipt);
  if (!isAbsolute(directory))
    throw new Error("Receipt output must be an absolute explicit directory");
  directory = resolve(await realpath(dirname(directory)), basename(directory));
  const withinFixtures = relative(await realpath(fixtureRoot), directory);
  if (
    !withinFixtures ||
    (!withinFixtures.startsWith("..") && !isAbsolute(withinFixtures))
  )
    throw new Error("Receipt output must be outside the frozen corpus");
  await mkdir(directory); // EEXIST is intentional: previous receipts are immutable.
  const bytes = encodeJson(receipt),
    pending = resolve(directory, "receipt.pending"),
    final = resolve(directory, "receipt.json");
  await writeFile(pending, bytes, { flag: "wx" });
  await link(pending, final);
  await unlink(pending);
  await writeFile(
    resolve(directory, "receipt.sha256"),
    `${sha256(bytes)}  receipt.json\n`,
    { flag: "wx" },
  );
  return final;
}
