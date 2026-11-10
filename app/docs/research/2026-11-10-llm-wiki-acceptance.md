# LLM Wiki acceptance cases

Status: Frozen development expectations, version 1, 2026-11-10. Outcomes below
are requirements, not execution results. See the [execution record](2026-11-10-llm-wiki-execution.md).

## Existing evaluation corpus

Reuse `src-tauri/eval/local-wiki-v1` without changing its sources, labels, splits
or manifests to accommodate an implementation. Its manifest SHA-256 is recorded
in the execution record. The initial fixture-integrity run selected 160 development
cases; it did not execute retrieval or generation. Calibration and held-out cases
remain separate from implementation tuning.

The following scenarios supplement that corpus for navigation, project scope and
publication behavior. Use temporary vaults named Synthetic Alpha and Synthetic
Beta, never a production folder. All names, records and text here are synthetic.
Freeze expectations before a fix. Add executable cases next to the owning module's
existing tests, and associate their command/results with these IDs in the record.

## Supplemental scenarios

| ID | Setup and action | Required result |
| --- | --- | --- |
| D1 | Alpha: title `Synthetic source`, body `Synthetic report draft`. Visit Ask, Settings and Reader, then reopen Ingest. | Both fields retain exact input. |
| D2 | With D1 saved, reload/restart, switch to Beta, enter `Different synthetic draft`, return to Alpha. | Each vault restores only its own draft. |
| D3 | Submit Alpha draft revision A; edit to revision B before A finishes. | Completion of A never clears B. Failure, cancellation and partial completion retain A if it remains current. |
| D4 | Inject a storage write failure while editing, then restore storage and retry. | Input stays in memory; persistence failure and recovery are visible. Retry saves the latest input only to the originating vault. |
| Q1 | Alpha has a wiki note plus workstream session facts. Explicitly select wiki scope and ask project progress. | No session-facts bypass; session-only claims are absent. An optional session search is disclosed before execution. |
| Q2 | Ask over a selected note, including a follow-up; unrelated session facts mention the same subject. | Evidence stays within the allowed note-path set. |
| Q3 | Query at `2026-11-10T03:00:00Z`, Asia/Seoul, with an explicit November 9 range. Only October records exist. | Empty requested period is explicit; old records are not silently substituted. |
| Q4 | Ask a topic-free recent question with only records older than the route's disclosed seven-day period. | Report no evidence in that period and allow an explicit wider search; do not silently anchor a new period to the latest old record. |
| Q5 | Start an answer in Alpha, switch to Beta before evidence/generation completes. | No Alpha result or write appears in Beta. |
| W1 | November 1 user: `Please implement the synthetic export test.` Assistant: `I plan to write it; it has not run.` | Requested/planned, never completed or verified. |
| W2 | November 2 assistant: `The synthetic export test passed locally.` No independent witness is present. | Reported completion with that source, not independently verified completion. |
| W3 | November 3 user: `The synthetic export test fails on the new fixture. Reopen it.` | Current state is reopened. A November 1 cutoff still returns W1, never W2/W3. |
| W4 | Beta has a different task also called `synthetic export test`. | No cross-project task merge or evidence leakage. |
| M1 | Create a map from two pages whose titles are similar but bodies describe unrelated topics. | No invented relationship based solely on titles; supported explanations cite actual member evidence. |
| M2 | Add an independently authored paragraph to a map, change one member source, refresh twice. | Only app-owned sections change; human paragraph survives byte-for-byte and no duplicate map is created. |
| M3 | Change a member revision or destination while map generation is running. | Stale publication is rejected and an actionable retry remains. |
| N1 | Import a synthetic source, import identical bytes again, then admit a changed revision. | Original raw bytes remain unchanged; identical reimport creates no duplicate canonical page; new revision has lineage and reviewable changes. |
| N2 | Interrupt native publication, reopen the isolated application, retry with access restored. | Source/draft preserved, durable state recovered and success reflects only completed work. |
| N3 | Prepare pinned artifacts, deny external egress, run N1 and grounded Ask through native boundaries. | Useful source-grounded output and resolvable citations; no remote fallback. A mocked model or quotation-only substitute does not satisfy required synthesis. |

## Evidence requirements

Each result records case ID, code revision and dirty state, test or runner command,
fixture version, OS/runtime, actual outcome, and evidence level: code, synthetic
browser, native transport, actual model, or installed app. Missing levels remain
unverified. Record original/final raw and human-section hashes for mutation cases.

Actual-model runs additionally record artifact revision/SHA, generation settings,
latency, peak memory and network policy/observations. Retain rejected output and
failures. Critical generated-answer cases require three recorded runs, each with
zero scope leaks, fabricated citations or unsupported completion claims. Positive
cases must answer usefully; abstaining on everything does not pass.

Windows must run native N1/N2 and the relevant failure suite on Windows. A macOS
path test can establish a portable-path fix, but cannot establish Windows file
identity, ACL, handle lifetime, durable replacement or installed-app acceptance.
