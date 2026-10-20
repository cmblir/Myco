import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadAndValidateReview } from "./local-wiki-eval-review-validate.mjs";
import { loadAndValidateRoles } from "./local-wiki-eval-role-validate.mjs";

for (const kind of ["review", "role"]) {
  test(`${kind} CLI exposes supplied-result failure separately from valid fixture identity`, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "myco-eval-cli-test-"));
    try {
      const loaded =
        kind === "review"
          ? await loadAndValidateReview()
          : await loadAndValidateRoles();
      const first =
        kind === "review"
          ? loaded.artifact.pairs[0].cases[0]
          : loaded.artifact.cases[0];
      const input = {
        version: 1,
        kind: kind === "review" ? "review_verdicts" : "role_assessments",
        suiteId: loaded.artifact.id,
        suiteManifestSha256: loaded.manifestSha256,
        provenance: "synthetic_mock",
        results: [{ caseId: first.id, status: "completed" }],
      };
      const results = resolve(directory, "invalid-results.json");
      await writeFile(results, JSON.stringify(input));
      const run = spawnSync(
        "node",
        [
          `app/scripts/local-wiki-eval-${kind}-run.mjs`,
          "--output",
          resolve(directory, "receipt"),
          "--results",
          results,
        ],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 1);
      const summary = JSON.parse(run.stdout.trim());
      assert.equal(summary.fixtureStatus, "valid");
      assert.equal(summary.validationStatus, "failed");
      assert.equal(summary.validationFailures.length, 1);
      assert.match(summary.validationFailures[0].error, /identity|hash/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test(`${kind} CLI rejects malformed supplied JSON without echoing its contents`, async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "myco-eval-cli-json-test-"),
    );
    try {
      const marker = "SYNTHETIC_PRIVATE_MARKER_DO_NOT_LOG";
      const results = resolve(directory, "invalid-results.json");
      await writeFile(results, marker);
      const run = spawnSync(
        "node",
        [
          `app/scripts/local-wiki-eval-${kind}-run.mjs`,
          "--output",
          resolve(directory, "receipt"),
          "--results",
          results,
        ],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 1);
      const receipt = await readFile(
        resolve(directory, "receipt", "receipt.json"),
        "utf8",
      );
      for (const exposed of [run.stdout, run.stderr, receipt])
        assert.equal(exposed.includes("SYNTHETIC_"), false);
      assert.match(
        JSON.parse(run.stdout.trim()).validationFailures[0].error,
        /valid JSON/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
