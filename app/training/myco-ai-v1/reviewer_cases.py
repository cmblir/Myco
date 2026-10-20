"""Prepare eight exposed-development claim reviews; no inference or native authority."""

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from export import output_directory

REPO = Path(__file__).resolve().parents[3]
EVAL = REPO / "app/src-tauri/eval"
STEM = "local-wiki-development-review-packets-v1"
PINS = {
    STEM + ".manifest.json": "470fed90af029cc5e900f680734a3567f24c7c4b95b6c2a5457d02338a305732",
    STEM + ".json": "208f70a7c653e9c38ba3b1d4a4a39a09cc38d5f4be1c4fd7bd8dfabd0c005e31",
    "local-wiki-development-meaning-v1.json": "d697b33b60d555615a8e921158f3baeda1c003c6cac3c4a69d5cbe5d000f348c",
}
EXPECTED = {
    "whole-review-D4AB-rollout-invention": ((2, "covered", []), (3, "covered", [])),
    "whole-review-D3AB-duplicate-only": ((3, "covered", []), (2, "missing", ["D3A", "D3B"])),
    "whole-review-D4ABC-omit-nonrollout": ((4, "covered", []), (3, "missing", ["D4C"])),
    "whole-review-D1AB-omit-request": ((4, "covered", []), (3, "missing", ["D1A"])),
}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def checked_json(path):
    raw = path.read_bytes()
    if digest(raw) != PINS[path.name]:
        raise ValueError(f"Frozen development artifact changed: {path.name}")
    return json.loads(raw)


def verify_case(case, packet, original):
    """Rebind every complete selected turn and the current production model wire."""
    source, view, reference = original["source"], case["userPreview"], case["reference"]
    raw = source["original"].encode()
    if len(raw) != source["bytes"] or digest(raw) != source["sha256"]:
        raise ValueError("Original bytes or revision changed")
    turns = {turn["id"]: turn for turn in source["turns"]}
    selected = packet["selectedSpanIds"]
    if (set(selected) & set(packet["excludedSpanIds"]) or len(selected) != len(set(selected))
            or set(selected + packet["excludedSpanIds"]) != set(turns)):
        raise ValueError("Selected/excluded originals no longer form the declared packet")
    spans = []
    for span_id in selected:
        turn = turns[span_id]
        text = raw[turn["start"]:turn["end"]].decode()
        if text != turn["text"] or digest(text.encode()) != turn["sha256"]:
            raise ValueError("Complete original turn bytes or span hash changed")
        spans.append({"id": span_id, "sourceId": source["id"], "sourcePath": source["path"],
                      "selectionPath": source["selectionPath"], "sourceRevision": source["sha256"],
                      **{key: turn[key] for key in ("start", "end", "sha256", "text", "turnId",
                                                    "speaker", "turnTime", "sourcePhase")},
                      "recordTime": source["recordTime"]})
    request = case["request"]
    if (request["scope"] != "all" or request["range"] is not None or request["resolution"] is not None
            or request["previousQuestion"] is not None or request["modelId"] is not None
            or request["activityOverview"] is not False):
        raise ValueError("Development packet no longer has its neutral ordinary-review context")
    context = {"question": request["question"], "language": request["lang"], "scope": "all",
               "activityPeriod": None, "requestedPeriod": None, "resolutionWindow": None,
               "previousQuestion": None}
    binding = {"origin": request["origin"], "roleSnapshot": request["roleSnapshot"],
               "requestId": request["requestId"], "paths": request["paths"], "context": context}
    claims = case["proposalBatch"]["claims"]
    expected_view = {"context": context, "contextRevision": digest(canonical(binding).encode()),
                     "coverageRequiredSpanIds": selected, "referenceSpanIds": [], "originalSpans": spans,
                     "requiredClaimIds": [f"C{i}" for i in range(len(claims))],
                     "claims": [{"id": f"C{i}", "proposal": claim} for i, claim in enumerate(claims)],
                     "independentVerificationReceipts": []}
    if view != expected_view or reference["coverageRequiredSpanIds"] != selected:
        raise ValueError("Frozen preview differs from the production claim-review wire")
    variant = {"source_supported": 0, "comparison": 1}[case["variant"]]
    count, coverage, missing = EXPECTED[case["pairId"]][variant]
    dispositions = ["supported"] * count
    if variant and case["pairId"] == "whole-review-D4AB-rollout-invention":
        dispositions[-1] = "unsupported"
    expected_decisions = [{"id": f"C{i}", "disposition": value} for i, value in enumerate(dispositions)]
    actual_decisions = [{key: decision[key] for key in ("id", "disposition")}
                        for decision in reference["expectedDecisions"]]
    if (len(claims) != count or actual_decisions != expected_decisions
            or reference["sourceCoverage"] != coverage or reference["missingSpanIds"] != missing
            or reference["expectedVerdict"] != ("accept" if not variant else "reject")):
        raise ValueError("Automated source-reviewed development reference changed")


def validate_verdict(value, payload):
    """Mirror the observed native shape checks; this does not execute that validator."""
    if (not isinstance(value, dict) or set(value) != {"version", "claims", "sourceCoverage", "missingSpanIds"}
            or value["version"] != "WikiClaimReviewV1" or not isinstance(value["claims"], list)):
        raise ValueError("Invalid WikiClaimReviewV1 shape")
    ids = []
    for decision in value["claims"]:
        if (not isinstance(decision, dict) or set(decision) != {"id", "disposition", "reason"}
                or not isinstance(decision["id"], str)
                or decision["disposition"] not in ("supported", "unsupported", "uncertain")):
            raise ValueError("Invalid claim decision")
        reason = decision["reason"]
        if (not isinstance(reason, str) or not reason.strip() or len(reason) > 128
                or any(unicodedata.category(char) == "Cc" for char in reason)):
            raise ValueError("Invalid reason")
        ids.append(decision["id"])
    missing = value["missingSpanIds"]
    if (sorted(ids) != sorted(payload["requiredClaimIds"]) or len(ids) != len(set(ids))
            or value["sourceCoverage"] not in ("covered", "missing", "uncertain")
            or not isinstance(missing, list) or any(not isinstance(item, str) for item in missing)
            or len(missing) > 8 or len(missing) != len(set(missing))
            or not set(missing) <= set(payload["coverageRequiredSpanIds"])
            or (value["sourceCoverage"] == "covered" and missing)):
        raise ValueError("Invalid required decisions or original-span coverage")


def build_cases():
    """Keep evaluator references outside all eight runtime message packets."""
    manifest = checked_json(EVAL / (STEM + ".manifest.json"))
    artifact = checked_json(EVAL / (STEM + ".json"))
    corpus = checked_json(EVAL / "local-wiki-development-meaning-v1.json")
    policy_file = REPO / "app/src-tauri/src/wiki_claim_review.rs"
    policy = policy_file.read_text()
    match = re.search(r'const SYSTEM: &str = r#"(.*?)"#;', policy, re.DOTALL)
    if not match:
        raise ValueError("Cannot extract the actual production claim-review SYSTEM")
    system = match.group(1)
    packets = {packet["pairId"]: packet for packet in artifact["packets"]}
    originals = {case["id"]: case for case in corpus["cases"]}
    if set(packets) != set(EXPECTED) or len(artifact["cases"]) != 8:
        raise ValueError("Expected exactly the four exposed development pairs")
    rows, rubrics, seen = [], [], set()
    for case in artifact["cases"]:
        identity = (case["pairId"], case["variant"])
        if identity in seen:
            raise ValueError("Repeated paired variant")
        seen.add(identity)
        verify_case(case, packets[case["pairId"]], originals[case["sourceCaseId"]])
        rows.append({"messages": [{"role": "system", "content": system},
                                   {"role": "user", "content": canonical(case["userPreview"])}]})
        rubrics.append({"id": case["id"], "pair_id": case["pairId"], "task": "claim_review_development",
                        "family": case["sourceCaseId"], "expected": {"schema": "WikiClaimReviewV1"},
                        "input_sha256": digest(canonical(rows[-1]["messages"]).encode()),
                        "reference": copy.deepcopy(case["reference"]),
                        "source_documents": [copy.deepcopy(originals[case["sourceCaseId"]]["source"])],
                        "excluded_span_ids": packets[case["pairId"]]["excludedSpanIds"]})
    if seen != {(pair, variant) for pair in EXPECTED for variant in ("source_supported", "comparison")}:
        raise ValueError("A paired variant is missing")
    metadata = {"purpose": "exposed_development_diagnostic", "synthetic_only": True,
                "pairs": 4, "scheduled_verdicts": 8, "independent_source_families": 3,
                "source_review": "automated_source_text_review_not_human", "human_reviewed": False,
                "final_holdout": False, "prior_development_outputs_known": True,
                "claim_review_only": True, "answer_review_gate_verified": False,
                "native_validator_executed": False, "native_token_fit_verified": False,
                "app_success_verified": False, "production_adoption": False,
                "source_sha256": PINS, "system_sha256": digest(system.encode()),
                "policy_file_sha256": digest(policy_file.read_bytes()),
                "prior_source_audit_sha256_declared_by_manifest": manifest["sourceAuditSha256"],
                "prior_source_audit_bytes_rechecked": False}
    return {"rows": rows, "rubrics": rubrics, "metadata": metadata}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New absolute external directory")
    args = parser.parse_args()
    destination = output_directory(args.output)
    fixture = build_cases()
    destination.mkdir(parents=True, exist_ok=False)
    with (destination / "frozen-cases.json").open("x", encoding="utf-8") as handle:
        json.dump(fixture, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps({"output": str(destination), **fixture["metadata"]}))


if __name__ == "__main__":
    main()
