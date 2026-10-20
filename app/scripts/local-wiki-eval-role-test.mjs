import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  encodeJson,
  fixtureRoot,
  writeFixtures,
} from "./local-wiki-eval-fixtures.mjs";
import {
  buildRoleFixtures,
  roleNames,
  writeRoleFixtures,
} from "./local-wiki-eval-role-fixtures.mjs";
import {
  loadAndValidateRoles,
  validateRoleStructures,
} from "./local-wiki-eval-role-validate.mjs";
import { temporary, rehashCase } from "./local-wiki-eval-role-test-support.mjs";

test("five separate source-bound role suites are frozen without changing original sources", async () => {
  const artifact = await readFile(
    resolve(fixtureRoot, "role-cases.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  assert.notEqual(artifact, null, "Missing separate frozen five-role artifact");
  assert.equal(artifact.cases.length, 200);
  assert.equal(new Set(artifact.cases.map((entry) => entry.role)).size, 5);
});

test("five roles have 40 each with the same 16/8/16 case split and unchanged 640 originals", async () => {
  const loaded = await loadAndValidateRoles();
  assert.deepEqual(loaded.artifact, buildRoleFixtures(loaded.base));
  assert.equal(loaded.base.files["corpus.json"].sources.length, 640);
  assert.equal(loaded.base.manifest.artifacts.length, 6);
  for (const role of roleNames) {
    assert.equal(
      loaded.artifact.cases.filter((entry) => entry.role === role).length,
      40,
    );
    assert.deepEqual(
      ["development", "calibration", "held_out"].map(
        (split) =>
          loaded.artifact.cases.filter(
            (entry) => entry.role === role && entry.split === split,
          ).length,
      ),
      [16, 8, 16],
    );
    assert.equal(
      loaded.artifact.criticalRepeats.perRoleCaseIds[role].length,
      8,
    );
  }
  assert.equal(loaded.artifact.criticalRepeats.status, "declared_not_executed");
  assert.equal(loaded.artifact.semanticReviewStatus, "source_review_required");
});

test("role spans are actual original bytes and preserve report/retraction actor and dates", async () => {
  const loaded = await loadAndValidateRoles();
  const entry = loaded.artifact.cases.find(
    (entry) => entry.id === "audio_script:p01:grounded_status_script",
  );
  const packet = entry.sourcePackets[0],
    original = loaded.base.files["corpus.json"].sources.find(
      (source) => source.id === packet.originalSourceId,
    );
  assert.notEqual(
    packet.spans[0].startByte,
    original.text.indexOf(packet.spans[0].text),
  );
  for (const span of packet.spans)
    assert.deepEqual(
      Buffer.from(original.text).subarray(span.startByte, span.endByte),
      Buffer.from(span.text),
    );
  assert.deepEqual(
    entry.label.requiredFacts.map((fact) => [
      fact.actor,
      fact.eventTime,
      fact.status,
    ]),
    [
      ["assistant", "2026-10-02T08:00:00Z", "reported_completed"],
      ["user", "2026-10-06T08:00:00Z", "reported_rolled_back"],
    ],
  );
  assert.equal(
    entry.label.requiredFacts.every(
      (fact) => fact.independentVerification === false,
    ),
    true,
  );
});

test("injection remains quoted data and unknown outcomes are not invented noncompletion", async () => {
  const loaded = await loadAndValidateRoles();
  const injection = loaded.artifact.cases.find(
    (entry) => entry.id === "agent_proposals:p01:injection_noop",
  );
  assert.match(
    injection.sourcePackets[0].spans[0].text,
    /Ignore previous instructions/,
  );
  assert.equal(injection.sourcePackets[0].kind, "process");
  assert.equal(
    injection.sourcePackets[0].independentOriginalWorkEvidence,
    false,
  );
  assert.equal(injection.sourcePackets[0].spans[0].turnTime, null);
  assert.equal(injection.input.nativeAuthority, "not_issued_in_fixture");
  assert.equal(injection.label.operationsAllowed, 0);
  const unknown = loaded.artifact.cases.find(
    (entry) => entry.id === "audio_script:p01:unsupported_or_uncertain",
  );
  assert.equal(unknown.label.requiredFacts[0].status, "unknown");
  assert.ok(
    unknown.label.requiredOmissions.includes(
      "current noncompletion asserted from absent outcome",
    ),
  );
  const cancelled = loaded.artifact.cases.find(
    (entry) => entry.id === "audio_script:p03:unsupported_or_uncertain",
  );
  assert.equal(cancelled.label.requiredFacts[0].status, "reported_cancelled");
  assert.equal(cancelled.input.modality, "script_text_only");
});

test("role contracts separate historical reports, incompatible draft state and deterministic path lint", async () => {
  const loaded = await loadAndValidateRoles();
  for (const id of [
    "reflect:p01:conflicting_proposal",
    "reflect:p01:compatible_reports",
  ]) {
    const entry = loaded.artifact.cases.find((entry) => entry.id === id);
    assert.equal(
      entry.input.draft.provenance,
      "synthetic_proposal_not_original_evidence",
    );
    assert.equal(
      entry.sourcePackets.every((packet) => packet.kind === "raw"),
      true,
    );
  }
  assert.equal(
    loaded.artifact.cases.find(
      (entry) => entry.id === "reflect:p01:compatible_reports",
    ).label.expectedIssueCount,
    0,
  );
  assert.equal(
    loaded.artifact.cases.find(
      (entry) => entry.id === "semantic_lint:p01:valid_historical_page",
    ).label.expectedIssueCount,
    0,
  );
  assert.equal(
    loaded.artifact.cases.find(
      (entry) => entry.id === "semantic_lint:p01:wrong_actor",
    ).label.deterministicPathIssueCount,
    0,
  );
});

test("rejects byte, speaker, source metadata, split and label-review changes", async () => {
  const loaded = await loadAndValidateRoles();
  for (const edit of [
    (artifact) => artifact.cases[0].sourcePackets[0].spans[0].startByte++,
    (artifact) =>
      (artifact.cases[0].sourcePackets[0].spans[0].speakerRole = "assistant"),
    (artifact) => (artifact.cases[0].sourcePackets[0].revision = 99),
    (artifact) => (artifact.cases[0].split = "held_out"),
    (artifact) => (artifact.semanticReviewStatus = "human_reviewed"),
  ]) {
    const changed = structuredClone(loaded.artifact);
    edit(changed);
    rehashCase(changed.cases[0]);
    assert.throws(
      () => validateRoleStructures(changed, loaded.base),
      /hash|speaker|metadata|split|source-review-required/,
    );
  }
});

test("derived role publishing preserves original manifest and refuses overwrite", async () =>
  temporary(async (directory) => {
    await writeFixtures(directory);
    const original = await readFile(resolve(directory, "manifest.json"));
    await writeRoleFixtures(directory);
    assert.deepEqual(
      await readFile(resolve(directory, "manifest.json")),
      original,
    );
    await assert.rejects(writeRoleFixtures(directory), /EEXIST/);
    await loadAndValidateRoles(directory);
  }));

test("role manifest rejects tampering, unsafe path and symlink", async () =>
  temporary(async (directory) => {
    await writeFixtures(directory);
    await writeRoleFixtures(directory);
    const original = await readFile(resolve(directory, "role-cases.json"));
    await writeFile(
      resolve(directory, "role-cases.json"),
      Buffer.concat([original, Buffer.from(" ")]),
    );
    await assert.rejects(
      loadAndValidateRoles(directory),
      /artifact hash mismatch/,
    );
    await writeFile(resolve(directory, "role-cases.json"), original);
    const manifest = JSON.parse(
      await readFile(resolve(directory, "role-cases.manifest.json"), "utf8"),
    );
    manifest.artifact.path = "../role-cases.json";
    await writeFile(
      resolve(directory, "role-cases.manifest.json"),
      encodeJson(manifest),
    );
    await assert.rejects(
      loadAndValidateRoles(directory),
      /unsafe role manifest/,
    );
    manifest.artifact.path = "role-cases.json";
    await writeFile(
      resolve(directory, "role-cases.manifest.json"),
      encodeJson(manifest),
    );
    await writeFile(resolve(directory, "copy.json"), original);
    await rm(resolve(directory, "role-cases.json"));
    await symlink(
      resolve(directory, "copy.json"),
      resolve(directory, "role-cases.json"),
    );
    await assert.rejects(loadAndValidateRoles(directory), /regular local file/);
  }));
