"""Prepare two exposed fixed-answer review pairs; no inference or native authority."""

import argparse
import copy
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from export import output_directory

REPO = Path(__file__).resolve().parents[3]
RUNTIME = REPO / "app/src-tauri/eval/local-wiki-answer-review-qualification-v1/runtime-inputs.json"
RUNTIME_SHA = "e4c91504befb91caceed75ac90b1f6342e21fa5104cfe8a6e8051e1bcd36139c"
REFERENCES = {
    ("F01", "P01"): {"expected_verdict": "accept", "critical": False,
        "required_axes": {"answerDisposition": "supported", "taskResponse": "adequate",
                          "sourceCoverage": "covered", "missingSpanIds": []},
        "meaning": "User organized the list, requested a draft and left review notes. Assistant drafted; no dispatch/order is established."},
    ("F01", "P02"): {"expected_verdict": "reject", "critical": True,
        "required_axes": {"answerDisposition": "unsupported"},
        "meaning": "Dispatch and ordering are invented despite explicit non-dispatch/non-order and absent authorization."},
    ("F02", "P01"): {"expected_verdict": "reject", "critical": True,
        "required_axes": {"answerDisposition": "unsupported"},
        "meaning": "March 14 is the drawer-check record date, not an established event date; the event date is explicitly unrecorded."},
    ("F02", "P02"): {"expected_verdict": "accept", "critical": False,
        "required_axes": {"answerDisposition": "supported", "taskResponse": "adequate",
                          "sourceCoverage": "covered", "missingSpanIds": []},
        "meaning": "March 7 classification, later memo/font work and unknown drawer-check date remain distinct."},
}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def verify_family(family):
    """Rebuild all fourteen fields from every complete raw-document turn."""
    spans = []
    for index, document in enumerate(family["documents"], 1):
        raw = document["raw"].encode()
        boundary = raw.find(b"\n---\n")
        if (not raw.startswith(b"---\n") or boundary < 0 or len(raw) != document["utf8Bytes"]
                or digest(raw) != document["sha256"] or document["citationId"] != f"S{index}"):
            raise ValueError("Complete source document/hash/citation order changed")
        body = boundary + len(b"\n---\n")
        headers = raw[:boundary].decode().splitlines()
        for name, key in (("title", "title"), ("created", "created"), ("last_updated", "lastUpdated")):
            values = [line[len(name) + 2:] for line in headers if line.startswith(name + ": ")]
            if len(values) != 1 or json.loads(values[0]) != document[key]:
                raise ValueError("Source header binding changed")
        metadata = [line.removeprefix("turn_metadata: ") for line in headers if line.startswith("turn_metadata: ")]
        if len(metadata) != 1 or document["recordTime"] != document["created"]:
            raise ValueError("Original turn/record metadata changed")
        turns = json.loads(metadata[0])
        markers = list(re.finditer(rb"(?m)^\*\*(User|Assistant):\*\*\n", raw[body:]))
        if not turns or len(turns) != len(markers) or markers[0].start() != 0:
            raise ValueError("Complete original turn membership changed")
        for ordinal, (turn, marker) in enumerate(zip(turns, markers, strict=True)):
            start = body + marker.end()
            end = body + markers[ordinal + 1].start() if ordinal + 1 < len(markers) else len(raw)
            text = raw[start:end].decode()
            speaker = marker.group(1).decode().lower()
            if turn["original_role"] != speaker or turn["phase"] is not None:
                raise ValueError("Original speaker/phase changed")
            spans.append({"id": "Q-development-" + turn["message_id"], "sourceId": document["sourceId"],
                "sourcePath": document["path"], "selectionPath": document["path"],
                "sourceRevision": document["sha256"], "start": start, "end": end,
                "sha256": digest(text.encode()), "text": text, "turnId": turn["message_id"],
                "speaker": speaker, "recordTime": document["recordTime"],
                "turnTime": turn["timestamp"], "sourcePhase": None})
    if spans != family["originalSpans"]:
        raise ValueError("Complete original SourceSpan fields changed")


def model_payload(family, draft):
    """Use ordinary Flat review fields and the exact no-link deduplicated draft view."""
    answer = json.loads(draft["rawDraft"])
    if not isinstance(answer, dict) or set(answer) != {"answer", "sources"} or not isinstance(answer["answer"], str):
        raise ValueError("Expected a fixed AskAnswerV1 draft")
    prose = answer["answer"].strip()
    citations = [{"id": document["citationId"], "path": document["path"]} for document in family["documents"]]
    if (not prose or len(prose) > 1200
            or any(marker in prose for marker in ("<", ">", "](", "```", "[[", "]]"))
            or not isinstance(answer["sources"], list) or not answer["sources"]
            or any(not isinstance(item, str) for item in answer["sources"])
            or len(set(answer["sources"])) != len(answer["sources"])
            or not set(answer["sources"]) <= {citation["id"] for citation in citations}):
        raise ValueError("Fixed draft is outside this plain-prose citation-bound fixture")
    period = family["recordPeriodContext"]
    context = {"question": family["question"], "language": family["lang"], "scope": "all",
               "activityPeriod": None, "requestedPeriod": {"start": period["periodStart"],
               "end": str(date.fromisoformat(period["periodEndExclusive"]) - timedelta(days=1)),
               "startEpoch": None, "endEpoch": None}, "resolutionWindow": None, "previousQuestion": None}
    origin = {"vaultPath": "/synthetic/answer-review-development", "openingToken": "synthetic-not-native-opening"}
    role = {"snapshotId": "synthetic-answer-review-role", "origin": origin, "role": "ask", "usage": "foreground",
            "authorizationRevision": "synthetic-only", "routeSignature": {"role": "ask", "providerId": "synthetic-only",
            "modelId": "synthetic-only", "effort": "(default)", "executionLocation": "in-process",
            "artifactRevision": None, "artifactSha256": None, "runtimeContract": "synthetic-only",
            "signature": "not-a-native-issued-grant"}}
    binding = {"origin": origin, "roleSnapshot": role, "requestId": "synthetic-answer-review-" + family["familyId"],
               "paths": [document["path"] for document in family["documents"]], "context": context}
    return {"context": context, "contextRevision": digest(canonical(binding).encode()),
            "answer": {"proseWithoutModelLinkLabels": prose, "sourceIds": answer["sources"]},
            "answerInputRevision": digest(draft["rawDraft"].encode()),
            "originalSpans": copy.deepcopy(family["originalSpans"]), "citations": citations,
            "independentVerificationReceipts": []}


def validate_verdict(value, payload):
    """Check current production JSON shape only; never approve answer meaning."""
    if (not isinstance(value, dict) or set(value) != {"version", "answerDisposition", "taskResponse",
                "sourceCoverage", "missingSpanIds", "reason"} or value["version"] != "AskAnswerReviewV1"
            or value["answerDisposition"] not in ("supported", "unsupported", "uncertain")
            or value["taskResponse"] not in ("adequate", "inadequate", "uncertain")
            or value["sourceCoverage"] not in ("covered", "missing", "uncertain")):
        raise ValueError("Invalid AskAnswerReviewV1 shape")
    reason, missing = value["reason"], value["missingSpanIds"]
    if (not isinstance(reason, str) or not reason.strip() or len(reason) > 128
            or any(unicodedata.category(char) == "Cc" for char in reason)
            or not isinstance(missing, list) or any(not isinstance(item, str) for item in missing)
            or len(missing) > 8 or len(set(missing)) != len(missing)
            or not set(missing) <= {span["id"] for span in payload["originalSpans"]}
            or (value["sourceCoverage"] == "covered" and missing)):
        raise ValueError("Invalid reason or original-span coverage")


def build_cases():
    """Reuse F01/F02 source/draft bytes with evaluator-only automated references."""
    raw = RUNTIME.read_bytes()
    if digest(raw) != RUNTIME_SHA:
        raise ValueError("Frozen exposed-development runtime inputs changed")
    runtime = json.loads(raw)
    families = [family for family in runtime["families"] if family["familyId"] in {"F01", "F02"}]
    if [family["familyId"] for family in families] != ["F01", "F02"]:
        raise ValueError("Expected exactly the two declared exposed source families")
    policy_file = REPO / "app/src-tauri/src/local_synthesis/answer_review.rs"
    policy = policy_file.read_text()
    match = re.search(r'const SYSTEM:\s*&str\s*=\s*("(?:[^"\\]|\\.)*");', policy)
    if not match:
        raise ValueError("Cannot extract production answer-review SYSTEM")
    system = json.loads(match.group(1))
    rows, rubrics = [], []
    for family in families:
        verify_family(family)
        if [draft["proposalId"] for draft in family["fixedDrafts"]] != ["P01", "P02"]:
            raise ValueError("Fixed paired draft schedule changed")
        for draft in family["fixedDrafts"]:
            payload = model_payload(family, draft)
            messages = [{"role": "system", "content": system}, {"role": "user", "content": canonical(payload)}]
            rows.append({"messages": messages})
            rubrics.append({"id": family["familyId"] + "-" + draft["proposalId"], "pair_id": family["familyId"],
                "family": family["familyId"], "task": "answer_review_development", "synthetic_only": True,
                "expected": {"schema": "AskAnswerReviewV1"}, "input_sha256": digest(canonical(messages).encode()),
                "reference": copy.deepcopy(REFERENCES[(family["familyId"], draft["proposalId"])]),
                "source_documents": copy.deepcopy(family["documents"]), "raw_draft": draft["rawDraft"]})
    metadata = {"kind": "exposed_answer_review_development", "synthetic_only": True,
        "pairs": 2, "scheduled_verdicts": 4, "independent_source_families": 2,
        "source_review": "automated_source_text_review_not_human", "human_reviewed": False,
        "prior_development_outputs_known": True, "final_holdout": False,
        "presentation": "New ordinary Flat requested-period rendering of exposed F01/F02; prior QA presentation differs.",
        "negative_reference_axes": "Unsupported meaning is required; negative coverage/task axes need source review, not invented exact labels.",
        "source_sha256": {RUNTIME.name: RUNTIME_SHA}, "system_sha256": digest(system.encode()),
        "policy_file_sha256": digest(policy_file.read_bytes()), "context_binding_native_authorized": False,
        "native_draft_validator_executed": False, "native_review_validator_executed": False,
        "token_fit_verified": False, "semantic_acceptance": False, "app_success_verified": False,
        "production_adoption": False}
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
