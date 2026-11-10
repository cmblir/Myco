# Local-first LLM wiki execution status — 2026-10-09

The [model and validation plan](../specs/2026-10-08-llm-wiki-model-and-validation-plan.md)
is the execution contract. Core wiki features must work locally without paid
APIs, external accounts or cloud CLIs. External inference is optional only after
connection **and explicit selection for the relevant role**. Local failure does
not authorize cloud fallback. No newly researched model has been promoted.

This record reports the first implementation checkpoint, based on
`1de4f5ee8c51a913c57ab4e90c1b762c412b44d1` on
`fix/2026-10-08-local-wiki-integrity`. It separates implementation, code tests,
actual-model quality and installed acceptance. W00–W11 remain incomplete.

Checkpoint commits: `e963a186` freezes the synthetic evaluation contract;
`3b7d86b1` applies the checked scan and native opening/mutation boundaries.
Neither commit has been installed or promoted as a model-quality result.

## Work package state

| Package | Current state | Implemented or inspected | Required remaining evidence/work |
| --- | --- | --- | --- |
| W00: evaluation/preflight | In progress | Frozen synthetic corpus, project splits, hashes and fixture-integrity runner. | Review synthetic labels against source; actual production retrieval/generation replay, native/offline receipts and timing/resource hooks. |
| W01: read/scan preservation | In progress | Authoritative checked traversal; read failures abort full collection; incremental batches pre-read before store mutation and retain uncertain work. | Actual updater/public native dispatch with persisted-index recovery, installed unreadable/retry checks. |
| W02: mutation/execution boundary | In progress | Native opening identity; Agent/Reflect stale-work rejection; exact full-file Agent/MCP update CAS; legacy MCP confinement; authenticated HTTP regressions. | Ordinary editor CAS and remaining mutation inventory; dedicated read-only CLI execution; actual Tauri IPC/UI acceptance and external filesystem race limits. |
| W03: continuous imports | Planned | Existing exact-revision session queue and canonical summary are retained. | Atomic shared ledger, fail-closed load/save, projection annotation ownership, visible sweep outcomes, continuous admitted-revision queue and lineage. |
| W04: outcomes/recovery | Planned | Audit findings retained. | Correct partial/failed/pending states and success watermarks; restart-durable drafts, hash undo, bounded/path-specific Git and checked Python automation. |
| W05: claims/activity recall | Planned | Schema, period and semantic criteria specified. | Shared actor/time/speech-act claims, scoped dated/undated recall, bounded state resolution and useful local answers. |
| W06: organization/maps | Planned | E5 remains the control. | Approved anchors, calibration in chosen geometry, revision-bound cache, owned-section map refresh and semantic member coverage. |
| W07: one index publisher | Planned | W01 preservation changes are the prerequisite. | Shared lexical/dense generation, watch topology, root-bound dirty events, close/rebind behavior, inventory and revision-key caches. |
| W08: local execution/routing | Planned | Public E4B candidate metadata is pinned in a separate evaluation record. | Downloaded-byte verification, runtime/template/schema integration, explicit role routing, cancellation/scheduling/timing and actual zero-egress tests. |
| W09: generator selection | Planned | Gemma E4B is a candidate; Qwen 4B remains the failing control. | Local smoke, development screening, frozen finalists, held-out source review, per-role quality/resource decisions. |
| W10: embeddings/rerank | Planned | EmbeddingGemma 2 text is the primary challenger; E5/hybrid retained. | Reference vectors/accessor/prefix verification, retrieval and clustering comparisons, shadow migration/rollback; reranker only if gain is measured. |
| W11: learning/local release | Planned | Required integration/installed gates are defined. | Grounded Study/resurface/media, timing UI, no-account/offline/native acceptance and stable installed verification. |

These states do not label W01/W02 fully verified merely because their focused
tests pass. No private backlog is being compiled as a substitute for the missing
claim/quality gates. Optional external comparisons are not dependencies of local
release acceptance.

## Executed verification

| Command or scope | Result | What it establishes |
| --- | --- | --- |
| `node --test app/scripts/local-wiki-eval-test.mjs` | 12 passed | Frozen data identity, split/scope/time invariants and honest fixture receipts; no production/model/offline execution. |
| `npx vitest run` in `app/` | 337 files, 4,967 tests passed | Frontend/state regression coverage, including mocked IPC. |
| `npx tsc -b` | Passed | Type checking. |
| `npm run lint` | Passed with two existing `notchDriver.ts` effect-dependency warnings | ESLint; warnings remain outside this change. |
| `npm run build` | Passed | Web production build; existing Vite chunk/import warnings remain. This is not a signed native installation. |
| `cargo fmt --check` | Passed | Rust formatting. |
| `cargo clippy --all-targets -- -D warnings` | Passed after correcting two new permission-test literals to `0o0` | Rust static checks. The initial failure is retained in the development receipt. |
| `cargo test` | 1,273 passed, 16 ignored, zero failures across reported suites | Required Rust suites; ignored tests were not executed. |
| Final focused `cargo test --lib mcp_native:: -- --nocapture` | 129 passed | Includes 13 authenticated HTTP transport tests against synthetic temporary vaults. |
| `git diff --check` | Passed | Changed-line whitespace checks. |

Focused failures were reproduced before fixes for unreadable traversal, missing
full-file hashes/unchecked updates, stale opening dispatch, pending approval and
late-result ownership. The HTTP suite additionally exercises raw/outside aliases,
hardlinked ancillary logs, Git aliases, stale sessions and nested importer
dispatch. It does not prove all crash interleavings or arbitrary external
filesystem races are eliminated.

Development receipts are retained outside the repository/user vault. The Rust
gate directory is identified by the basename
`myco-integrity-code-gates-rerun-8907lz6f`; the preceding Clippy failure is in
`myco-integrity-code-gates-_omznfs_`. The W01 receipt directory is
`myco-goal-w01-vvs38yxw`, and the final MCP log is `myco-w02-mcp-final.log`.
These are local temporary receipt locations, not durable published artifacts.
The W00 fixture receipt is retained in the dedicated development cache under
`local-wiki-v1-w00-2026-10-09-49f0a397`. Private absolute paths and raw logs are
not part of this public summary. The frontend full-run result was observed in
tool output; no dedicated durable full-run log was retained for that run.

## Model research state

The [candidate artifact record](../../src-tauri/eval/local-model-artifacts.json)
pins Google's E4B QAT Q4_0 text file to revision
`4b4a2c1d584be7264f87aac328a1bc739ce81b6c`, declared size 5,154,941,280 bytes and
publisher SHA256
`676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee`.
The [official pinned tree](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/tree/4b4a2c1d584be7264f87aac328a1bc739ce81b6c)
and [EmbeddingGemma 2 model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2)
were checked on October 9, 2026. Publisher metadata does not establish a local
download checksum, app compatibility, memory footprint, speed or answer quality.
The candidate record explicitly keeps runtime verification false, semantic
quality `not_evaluated` and production acceptance false.

No newly researched weights were downloaded, no paid inference was run and no
production model selection or installed application was changed in this
checkpoint. The actual-model, egress-denied, native UI and installed acceptance
gates remain unexecuted. The original user-vault incident has not been diagnosed
by these synthetic tests.

## Known limits carried forward

- The legacy ledger loader still treats corrupt/read-error state as empty and
  can save during backfill. MCP `ledger_status` is consequently guarded as a
  mutation; guarding its origin does not repair ledger durability.
- Named-project writes are confined to their explicit project, but the existing
  global dirty notification lacks its root. Root-bound publisher events belong
  to W03/W07; do not infer lexical/dense freshness from a successful write.
- MCP import/export/Git work can hold the transition guard while a vault switch
  waits. Bounded children/scheduling remain W04/W08 work.
- Native close invalidates checked action identities; updater shutdown/rebind
  and ordinary command/editor revision contracts are not yet complete.
- Ask/Reflect/lint can still reach existing write-capable optional CLI runners.
  A read-only prompt or sandbox flag alone does not confine MCP, settings,
  filesystem reads or network. This F10 boundary remains a release requirement.
- Existing maps, claims and summaries have not been retrospectively graded or
  repaired. Valid JSON/IDs, citation existence and large source counts do not
  establish useful answers.

README was updated for the actual source preservation/opening/CAS changes and
links to the local-first plan. Next work follows its dependency graph, with
preservation/execution fixes before broader automatic compilation and candidate
promotion. Overall completion requires local semantic and installed evidence,
not additional passing mocked tests or a successful external answer.
