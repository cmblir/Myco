# Local wiki evaluation fixtures v1

This is a **synthetic reference corpus and integrity harness**, not a passing
model evaluation. No model, provider, native IPC, installed app or private vault
is exercised by its runner. Boundary/fault/routing scenarios are declarations
for future integration tests; checking their reference data does not execute
the production behavior.

The frozen project split is 8 development / 4 calibration / 8 held-out projects.
There are 60 session families, each with three immutable reference revisions:
request/plan, reported implementation or handoff, and later verification,
rollback/reopening, cancellation or unresolved status. Source event dates are
separate from import/modified dates. All source hashes are SHA256 of UTF-8 text.
There are 640 source records: 180 raw revisions, 60 session projections, 60 wiki
reference projections, 20 approved maps and 320 coordination distractors.
Reference projections are fixture inputs, not claims of actual model compilation.

| Suite                 |                      Total | Development / calibration / held-out |
| --------------------- | -------------------------: | ------------------------------------ |
| Retrieval             | 120 positive + 60 negative | 72 / 36 / 72                         |
| Ask/advice            |                         80 | 32 / 16 / 32                         |
| Session compilation   |                         60 | 24 / 12 / 24                         |
| Map refresh           |                         20 | 8 / 4 / 8                            |
| Study                 |                         40 | 16 / 8 / 16                          |
| Resurface impressions |                         20 | 8 / 4 / 8                            |

Every query variant, revision, claim and label belongs to its project split.
Negative cases have no permitted relevant evidence. Historical queries exclude
later source events; scoped relevance labels obey wiki/sessions/one-note scope.
Later-state probes declare 12 initial distractors and require separate resolution
evidence, so a future retrieval evaluator must measure expansion rather than
preloading the outcome into its initial top-K. Eight held-out rollback/advice
cases are designated for three repeats; repeats are not independent cases.

From the repository root, verify the fixture contract and focused harness tests:

```sh
node --test app/scripts/local-wiki-eval-test.mjs
node app/scripts/local-wiki-eval-run.mjs --output /absolute/new-receipt-directory
```

Choose a new output directory with an existing parent outside this corpus and
any user vault. The runner rejects frozen-corpus containment and existing output
directories; it does not discover user vaults or establish native isolation.
Use a dedicated development cache or synthetic temporary directory.
The receipt redacts the output destination as `<explicit-new-directory>`;
future executed-run receipts need exact commands retained privately and a
separate sanitized public summary. The default selection is development. An explicit
`--split held_out` selects held-out metadata for integrity checks only; it does
not run held-out inference. `--suite` can select retrieval, ask, compilation,
maps, study or resurface. All frozen artifact hashes are verified regardless of
selected suite. The receipt stores the selection, manifest/config/source/tool
hashes, commit plus dirty-tree state, deterministic checks and timing. It always
records `inferenceExecuted=false`, `modelQuality=not_evaluated`, and unmeasured
network counters as `null`. A valid fixture receipt cannot establish zero egress,
semantic quality, native integration or installed-app success.

`receipt.schema.json` describes this W00-only receipt. App-level validation adds
cross-field invariants. Future real-inference/native/offline receipts need a
separate executed-run schema with actual model/options, evidence/output and
semantic dispositions; do not relabel these integrity receipts as those runs.

The builder is deterministic but regeneration is an explicit freeze-breaking
maintainer action:

```sh
node app/scripts/local-wiki-eval-fixtures.mjs --write
```

Review the changed sources and labels before any inference, then commit the new
manifest. Prompts or thresholds tuned using held-out results require fresh
project families for final acceptance. Existing published retrieval/Ask probes
remain regression data. These project-held-out synthetic templates are a first
contract baseline, not representative proof of real-corpus or unseen-template
accuracy. Labels are synthetic references, **not human-reviewed evidence**.

The runner uses only Node built-ins and a read-only Git identity/status query.
It downloads no weights, reads no provider keys or user corpus, makes no API
calls, and invokes no external inference CLI. It does not assert that the
production application already meets the local-first contract.
