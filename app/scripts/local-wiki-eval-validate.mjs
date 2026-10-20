import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixtureRoot, sha256 } from "./local-wiki-eval-fixtures.mjs";

const suiteCounts = {
  retrieval: 180,
  ask: 80,
  compilation: 60,
  maps: 20,
  study: 40,
  resurface: 20,
};
const splitCounts = { development: 8, calibration: 4, held_out: 8 };
export const suites = Object.keys(suiteCounts);
export const splits = Object.keys(splitCounts);
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function unique(entries, name) {
  const ids = entries.map((entry) => entry.id);
  requireValue(new Set(ids).size === ids.length, `Duplicate ${name} ID`);
  return new Map(entries.map((entry) => [entry.id, entry]));
}

/** Validate fixture contracts only; this never grades generated answers. */
export function validateStructures(files) {
  const corpus = files["corpus.json"],
    queries = files["queries.json"],
    labels = files["labels.json"],
    config = files["config.json"],
    scenarios = files["scenarios.json"];
  requireValue(
    corpus?.syntheticOnly === true && corpus.id === "local-wiki-v1",
    "Synthetic corpus contract missing",
  );
  requireValue(
    labels?.status === "frozen_before_inference" &&
      labels.provenance ===
        "deterministic_synthetic_reference_not_human_reviewed",
    "Labels are not frozen synthetic references",
  );
  requireValue(
    config.defaultRoute === "local" &&
      config.inferenceExecuted === false &&
      config.modelQualityStatus === "not_evaluated",
    "Fixture configuration must not assert inference or quality",
  );
  const projects = unique(corpus.projects, "project"),
    timelines = unique(corpus.timelines, "timeline"),
    sources = unique(corpus.sources, "source"),
    cases = unique(queries.cases, "case"),
    referenceLabels = unique(labels.labels, "label"),
    claims = unique(labels.claims, "claim");
  requireValue(
    projects.size === 20 && timelines.size === 60 && claims.size === 60,
    "Expected 20 projects, 60 timeline families and 60 reference state claims",
  );
  const seenSplitProjects = new Set();
  for (const [split, count] of Object.entries(splitCounts)) {
    const ids = config.splits[split];
    requireValue(ids.length === count, `Wrong project count for ${split}`);
    for (const id of ids) {
      requireValue(!seenSplitProjects.has(id), "Project split leakage");
      seenSplitProjects.add(id);
      requireValue(projects.get(id)?.split === split, "Project split mismatch");
    }
    requireValue(
      corpus.timelines.filter((entry) => entry.split === split).length ===
        count * 3,
      `Wrong timeline count for ${split}`,
    );
  }
  requireValue(seenSplitProjects.size === 20, "Missing split project");
  for (const entry of sources.values()) {
    requireValue(
      projects.has(entry.projectId) &&
        (timelines.has(entry.familyId) ||
          entry.familyId === `${entry.projectId}:project`),
      "Unknown source project/family",
    );
    requireValue(
      timelines.get(entry.familyId)?.projectId === entry.projectId ||
        entry.familyId === `${entry.projectId}:project`,
      "Cross-project source family",
    );
    requireValue(
      /^(raw|wiki|sessions)\//.test(entry.path) &&
        !entry.path.includes("\\") &&
        entry.path
          .split("/")
          .every((part) => part && part !== "." && part !== ".."),
      "Unsafe source-relative path",
    );
    requireValue(
      entry.sha256 === sha256(entry.text),
      `Source hash mismatch: ${entry.id}`,
    );
    for (const origin of entry.derivedFrom ?? [])
      requireValue(
        sources.get(origin)?.projectId === entry.projectId,
        "Cross-project or missing source lineage",
      );
  }
  for (const project of projects.values()) {
    requireValue(
      project.timelineIds.length === 3 &&
        new Set(project.timelineIds).size === 3,
      "Project timeline count mismatch",
    );
    for (const id of project.timelineIds)
      requireValue(
        timelines.get(id)?.projectId === project.id,
        "Project timeline identity mismatch",
      );
  }
  for (const timeline of timelines.values()) {
    requireValue(
      projects.get(timeline.projectId)?.split === timeline.split,
      "Timeline split leakage",
    );
    requireValue(
      timeline.sourceRevisionIds.length >= 3 &&
        timeline.currentRevisionId === timeline.sourceRevisionIds.at(-1),
      "Missing timeline revisions/current identity",
    );
    timeline.sourceRevisionIds.forEach((id, index) =>
      requireValue(
        sources.get(id)?.familyId === timeline.id &&
          sources.get(id)?.kind === "raw" &&
          sources.get(id)?.revision === index + 1,
        "Timeline revision mismatch",
      ),
    );
    requireValue(
      claims.get(timeline.statusClaimId)?.familyId === timeline.id,
      "Missing timeline status claim",
    );
  }
  for (const claim of claims.values()) {
    const evidence = sources.get(claim.evidenceId);
    requireValue(
      evidence?.familyId === claim.familyId &&
        evidence.projectId === claim.projectId,
      "Claim evidence lineage mismatch",
    );
    requireValue(
      evidence.text.includes(claim.supportingText) &&
        claim.supportingText.includes(claim.eventTime),
      "Claim reference span/time absent from source",
    );
  }
  requireValue(
    cases.size === 400 && referenceLabels.size === cases.size,
    "Case/label count mismatch",
  );
  for (const [suite, count] of Object.entries(suiteCounts))
    requireValue(
      queries.cases.filter((entry) => entry.suite === suite).length === count,
      `Wrong case count for ${suite}`,
    );
  for (const entry of cases.values()) {
    const project = projects.get(entry.projectId),
      label = referenceLabels.get(entry.labelId);
    requireValue(
      project?.split === entry.split &&
        label?.split === entry.split &&
        label.projectId === entry.projectId &&
        label.caseId === entry.id,
      "Case/label split leakage",
    );
    requireValue(
      suites.includes(entry.suite) &&
        (timelines.get(entry.familyId)?.projectId === entry.projectId ||
          entry.familyId === `${entry.projectId}:project`),
      "Case family/suite mismatch",
    );
    for (const id of entry.evidenceIds)
      requireValue(
        sources.get(id)?.projectId === entry.projectId,
        "Cross-project or unknown case evidence",
      );
    for (const id of label.requiredClaimIds ?? [])
      requireValue(
        claims.get(id)?.projectId === entry.projectId,
        "Cross-project or unknown required claim",
      );
    for (const id of [
      ...(label.criticalEvidenceIds ?? []),
      ...(label.relevantEvidenceIds ?? []),
      ...(label.requiredMemberIds ?? []),
      ...(label.requiredResolutionEvidenceIds ?? []),
    ])
      requireValue(
        entry.evidenceIds.includes(id),
        "Expected evidence outside case snapshot",
      );
    if (label.expectedKind === "negative")
      requireValue(
        label.relevantEvidenceIds.length === 0,
        "Negative case has positive labels",
      );
    if (label.expectedKind === "positive") {
      requireValue(
        label.relevantEvidenceIds.length > 0,
        "Positive case missing relevance labels",
      );
      for (const id of label.relevantEvidenceIds) {
        const evidence = sources.get(id);
        requireValue(
          entry.scope !== "wiki" || evidence.kind === "wiki",
          "Wiki relevance label outside scope",
        );
        requireValue(
          entry.scope !== "sessions" || evidence.kind === "sessions",
          "Session relevance label outside scope",
        );
        requireValue(
          entry.scope !== "one_note" || id === entry.noteSourceId,
          "One-note relevance label outside scope",
        );
        requireValue(
          !entry.asOf ||
            !evidence.eventTime ||
            evidence.eventTime <= entry.asOf,
          "Future evidence in historical label",
        );
      }
    }
    if (label.initialCandidateIds) {
      requireValue(
        label.initialCandidateIds.length === 12,
        "Resolution probe must fill initial top-K",
      );
      for (const id of label.requiredResolutionEvidenceIds)
        requireValue(
          !label.initialCandidateIds.includes(id),
          "Required later evidence already in initial top-K",
        );
    }
  }
  for (const project of projects.values()) {
    const projectCases = queries.cases.filter(
      (entry) => entry.projectId === project.id,
    );
    requireValue(
      projectCases.filter(
        (entry) =>
          referenceLabels.get(entry.labelId).expectedKind === "positive",
      ).length === 6 &&
        projectCases.filter(
          (entry) =>
            referenceLabels.get(entry.labelId).expectedKind === "negative",
        ).length === 3,
      "Expected six positive and three negative queries per project",
    );
  }
  requireValue(
    config.criticalRepeatCaseIds.length === 8 &&
      new Set(config.criticalRepeatCaseIds).size === 8 &&
      config.criticalRepeats === 3,
    "Critical repeat contract mismatch",
  );
  for (const id of config.criticalRepeatCaseIds)
    requireValue(
      cases.get(id)?.split === "held_out" && cases.get(id)?.critical === true,
      "Critical repeat outside held-out critical set",
    );
  requireValue(
    scenarios.status === "declared_not_executed",
    "Boundary scenarios cannot assert execution",
  );
  unique(scenarios.scenarios, "scenario");
  for (const scenario of scenarios.scenarios.filter(
    (entry) => entry.kind === "date_boundary",
  ))
    for (const event of scenario.events)
      requireValue(
        event.eligible ===
          (event.at >= scenario.interval.from &&
            event.at < scenario.interval.toExclusive),
        "Boundary reference interval mismatch",
      );
  return [
    "artifact/source identity",
    "project-family split isolation",
    "suite counts and frozen labels",
    "scope/as-of and lineage references",
    "later-state top-K probe",
    "declared boundary scenarios",
  ];
}

/** Read only the manifest's fixed local files, rejecting tampering and symlinks. */
export async function loadAndValidate(root = fixtureRoot) {
  const manifestBytes = await readFile(resolve(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  requireValue(
    manifest.id === "local-wiki-v1" &&
      manifest.syntheticOnly === true &&
      manifest.labelStatus === "frozen_before_inference",
    "Unexpected fixture manifest",
  );
  const expected = [
    "corpus.json",
    "queries.json",
    "labels.json",
    "config.json",
    "scenarios.json",
    "receipt.schema.json",
  ];
  requireValue(
    manifest.artifacts.length === expected.length &&
      new Set(manifest.artifacts.map((entry) => entry.path)).size ===
        expected.length &&
      manifest.artifacts.every((entry) => expected.includes(entry.path)),
    "Unknown/unsafe manifest artifact",
  );
  const files = {};
  for (const artifact of manifest.artifacts) {
    const path = resolve(root, artifact.path),
      stat = await lstat(path);
    requireValue(
      stat.isFile() && !stat.isSymbolicLink(),
      "Fixture artifact must be a regular local file",
    );
    const bytes = await readFile(path);
    requireValue(
      bytes.length === artifact.bytes && sha256(bytes) === artifact.sha256,
      `Artifact hash mismatch: ${artifact.path}`,
    );
    files[artifact.path] = JSON.parse(bytes);
  }
  const checks = validateStructures(files);
  requireValue(
    manifest.counts.projects === 20 &&
      manifest.counts.timelineFamilies === 60 &&
      manifest.counts.sourceRevisions ===
        files["corpus.json"].sources.filter((entry) => entry.kind === "raw")
          .length,
    "Manifest corpus counts mismatch",
  );
  for (const [suite, count] of Object.entries(suiteCounts))
    if (suite !== "retrieval")
      requireValue(
        manifest.counts[suite] === count,
        "Manifest suite counts mismatch",
      );
  requireValue(
    manifest.counts.retrievalPositive === 120 &&
      manifest.counts.retrievalNegative === 60,
    "Manifest retrieval counts mismatch",
  );
  return { manifest, manifestSha256: sha256(manifestBytes), files, checks };
}
