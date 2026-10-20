import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildFixtures,
  encodeJson,
  fixtureRoot,
  sha256,
  writeFixtures,
} from "./local-wiki-eval-fixtures.mjs";
import {
  loadAndValidate,
  validateStructures,
} from "./local-wiki-eval-validate.mjs";
import { validateReceipt, writeReceipt } from "./local-wiki-eval-receipt.mjs";
import { parseArguments, runIntegrity } from "./local-wiki-eval-run.mjs";

async function temporary(run) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "myco-local-wiki-fixture-"),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("fixed synthetic corpus has stable bytes, planned suite counts and grouped splits", () => {
  const files = buildFixtures();
  assert.equal(encodeJson(files), encodeJson(buildFixtures()));
  assert.equal(validateStructures(files).length, 6);
  assert.equal(files["corpus.json"].sources.length, 640);
  assert.equal(
    files["corpus.json"].sources.filter((entry) => entry.kind === "raw").length,
    180,
  );
  const cases = files["queries.json"].cases;
  assert.deepEqual(
    ["development", "calibration", "held_out"].map(
      (split) => cases.filter((entry) => entry.split === split).length,
    ),
    [160, 80, 160],
  );
  assert.deepEqual(
    ["retrieval", "ask", "compilation", "maps", "study", "resurface"].map(
      (suite) =>
        cases.filter(
          (entry) => entry.split === "held_out" && entry.suite === suite,
        ).length,
    ),
    [72, 32, 24, 8, 16, 8],
  );
});

test("rejects a timeline moved across project families", () => {
  const files = buildFixtures();
  files["corpus.json"].timelines[0].projectId = "p13";
  assert.throws(
    () => validateStructures(files),
    /source family|timeline identity/,
  );
});
test("rejects a query and label moved into a different split", () => {
  const files = buildFixtures();
  files["queries.json"].cases[0].split = "held_out";
  files["labels.json"].labels[0].split = "held_out";
  assert.throws(() => validateStructures(files), /split leakage/);
});
test("rejects scoped relevance outside wiki and one-note evidence", () => {
  const files = buildFixtures();
  const entry = files["queries.json"].cases.find(
    (entry) => entry.id === "retrieval:p01:wiki_recent",
  );
  files["labels.json"].labels.find(
    (label) => label.caseId === entry.id,
  ).relevantEvidenceIds = ["p01:t1:r3"];
  assert.throws(() => validateStructures(files), /Wiki relevance/);
  const oneNote = buildFixtures();
  oneNote["queries.json"].cases.find(
    (entry) => entry.id === "retrieval:p01:exact",
  ).noteSourceId = "p01:t2:wiki";
  assert.throws(() => validateStructures(oneNote), /One-note relevance/);
});
test("rejects reference claims whose span was removed even when the source hash is updated", () => {
  const files = buildFixtures(),
    claim = files["labels.json"].claims[0];
  const evidence = files["corpus.json"].sources.find(
    (entry) => entry.id === claim.evidenceId,
  );
  evidence.text = "Synthetic text without the recorded outcome.\n";
  evidence.sha256 = sha256(evidence.text);
  assert.throws(() => validateStructures(files), /span\/time absent/);
});
test("rejects a future outcome in an historical reference label", () => {
  const files = buildFixtures();
  files["labels.json"].labels.find(
    (label) => label.caseId === "retrieval:p01:historical",
  ).relevantEvidenceIds = ["p01:t1:r3"];
  assert.throws(() => validateStructures(files), /Future evidence/);
});
test("late-resolution reference is absent from the initial top-K", () => {
  const files = buildFixtures();
  const label = files["labels.json"].labels.find(
    (label) => label.caseId === "retrieval:p01:late_resolution",
  );
  label.initialCandidateIds[0] = label.requiredResolutionEvidenceIds[0];
  assert.throws(() => validateStructures(files), /already in initial top-K/);
});
test("checked artifacts match the manifest and frozen builder", async () => {
  const result = await loadAndValidate();
  for (const [file, expected] of Object.entries(buildFixtures()))
    assert.deepEqual(result.files[file], expected);
  assert.equal(result.manifest.artifacts.length, 6);
});
test("detects changed labels without an updated freeze manifest", async () =>
  temporary(async (directory) => {
    await writeFixtures(directory);
    const labels = JSON.parse(
      await readFile(resolve(directory, "labels.json"), "utf8"),
    );
    labels.labels[0].expectedStatus = "invented_complete";
    await writeFile(resolve(directory, "labels.json"), encodeJson(labels));
    await assert.rejects(loadAndValidate(directory), /Artifact hash mismatch/);
  }));
test("rejects manifest traversal and artifact symlinks", async () =>
  temporary(async (directory) => {
    const manifest = await writeFixtures(directory);
    manifest.artifacts[0].path = "../corpus.json";
    await writeFile(resolve(directory, "manifest.json"), encodeJson(manifest));
    await assert.rejects(
      loadAndValidate(directory),
      /Unknown\/unsafe manifest/,
    );
    await writeFixtures(directory);
    await writeFile(
      resolve(directory, "corpus-copy.json"),
      await readFile(resolve(directory, "corpus.json")),
    );
    await rm(resolve(directory, "corpus.json"));
    await symlink(
      resolve(directory, "corpus-copy.json"),
      resolve(directory, "corpus.json"),
    );
    await assert.rejects(loadAndValidate(directory), /regular local file/);
  }));
test("CLI defaults to development and rejects duplicate/unknown arguments", () => {
  assert.deepEqual(parseArguments(["--output", "/tmp/synthetic-receipt"]), {
    output: "/tmp/synthetic-receipt",
    split: "development",
    suite: "all",
  });
  assert.throws(
    () =>
      parseArguments([
        "--output",
        "/tmp/a",
        "--split",
        "development",
        "--split",
        "held_out",
      ]),
    /Duplicate/,
  );
  assert.throws(
    () => parseArguments(["--output", "/tmp/a", "--model", "remote"]),
    /Usage/,
  );
  assert.throws(
    () => parseArguments(["--output", "/tmp/a", "--split", "all"]),
    /valid split/,
  );
});
test("integrity receipt records identity, not semantic quality or measured egress", async () =>
  temporary(async (directory) => {
    const result = await runIntegrity({
      output: resolve(directory, "run"),
      split: "development",
      suite: "all",
    });
    const receipt = result.receipt;
    assert.equal(receipt.fixtureStatus, "valid");
    assert.equal(receipt.selection.caseIds.length, 160);
    assert.equal(receipt.sourceSnapshots.length, 256);
    assert.equal(receipt.toolSnapshots.length, 5);
    assert.equal(receipt.modelQuality, "not_evaluated");
    assert.equal(receipt.inferenceExecuted, false);
    assert.deepEqual(receipt.networkObservations, {
      attempted: null,
      blocked: null,
      successful: null,
    });
    const bytes = await readFile(result.path);
    assert.equal(
      await readFile(resolve(directory, "run/receipt.sha256"), "utf8"),
      `${sha256(bytes)}  receipt.json\n`,
    );
    const schema = JSON.parse(
      await readFile(resolve(fixtureRoot, "receipt.schema.json"), "utf8"),
    );
    assert.deepEqual(
      Object.keys(receipt).sort(),
      schema.required.slice().sort(),
    );
    for (const key of ["inferenceExecuted", "modelQuality", "kind"])
      assert.equal(receipt[key], schema.properties[key].const);
    assert.throws(
      () => validateReceipt({ ...receipt, modelQuality: "accepted" }),
      /cannot assert inference/,
    );
    assert.throws(
      () =>
        validateReceipt({
          ...receipt,
          networkObservations: { attempted: 0, blocked: 0, successful: 0 },
        }),
      /does not measure/,
    );
    await assert.rejects(
      writeReceipt(resolve(directory, "run"), receipt),
      /EEXIST/,
    );
    await assert.rejects(
      writeReceipt(resolve(fixtureRoot, "forbidden-receipt"), receipt),
      /outside the frozen/,
    );
  }));
