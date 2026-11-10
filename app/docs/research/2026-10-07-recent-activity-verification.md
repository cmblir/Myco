# Recent activity answer verification — October 7–8, 2026

The reported question, **내가 최근에 한 일들에 대해서 정리해줘**, produced an
incidental site-count fact in the installed Qwen 4B/wiki path. That does not
answer a personal-work overview. Valid JSON and a valid source link did not
establish question relevance.

## Reproduction and intended behavior

The bare recent-work wording had no parsed period, so it bypassed the existing
dated-activity route and reached generic similarity retrieval and factual
generation. Two regression tests failed before implementation: the model period
planner was called zero times, and planner failure did not create an error turn.
The fixtures use synthetic records and an incidental count, not private bodies.

The user explicitly chose model judgment over a fixed default period. The local
model therefore selects a validated civil-day range from the question, today
and available scoped record dates. An explicit retry period bypasses replanning.
The selected period appears before summary generation. No automatic Ask deadline
is added; elapsed time and exact-request Stop remain available.

Activity retrieval reads complete indexed passages from dated buckets, exact
turn metadata or validated wiki creation/update dates. Document dates locate
records, not all actions mentioned in them. Unknown/malformed turn dates are not
replaced with document dates. Scope, path restrictions, cold-source policy,
confinement, full-page chunk hashes and before/after generation revisions remain
checked. Opaque filenames and filesystem modification time are not recency
evidence.

A bounded date catalog precedes complete-page selection: up to 512 headers of
8 KiB, then up to 64 complete files, 512 KiB per file and 8 MiB total including
headers. Up to 12 complete chunks are selected with page diversity; local prompt
preparation may retain fewer within 4,096-context/192-output bounds.
The UI reports partial coverage rather than promising a complete work inventory.
Explicitly dated activity questions keep the existing route.

The activity-only generation policy combines work themes, attributes reports and
keeps plans/requests separate from completion. Unrelated similarity hits never
replace a failed planner or summary. Empty period evidence is distinct from
failed generation. Existing factual and next-work policies are unchanged.

## Verification status

The full frontend suite passed: 333 files, 4,810 tests. An earlier native `cargo
test --all-targets` passed 1,155 tests with 15 ignored; benchmark smoke targets
also completed. TypeScript build, scoped ESLint, `cargo fmt --check` and an
earlier all-targets Clippy check passed. Subsequent checks and failures are
recorded below; these results do not validate later source changes.

The new regression coverage includes model-selected periods, exact-request Stop,
late-result rejection, scoped complete-passage retrieval, record-versus-action
dates, actor/status attribution policy, partial coverage and generation failure
without unrelated factual fallback. The existing quote-only, factual and dated
activity paths remain covered. An initial full frontend run found two missing
development-mock command entries; the entries were added without fabricating
model judgment or private-record results, and the full suite was rerun.

### Actual Qwen 4B policy comparison

The opt-in release probe ran the verified installed Qwen 4B artifact through the
production complete-passage preparation, 192-output/2,048-context bounds and
validator. The initial policy produced valid cited JSON on all three synthetic
inputs but failed semantic review: October 6 became late October, assistant
report attribution disappeared, and a count-only record became an answer about
the site count. Those outputs were not treated as successful verification.

Two subsequent candidates were also rejected. One retained the incidental count;
another omitted the reported result/unrecorded outcome and changed a user's
rollback report into a request. Historical candidate 4 retained the following
core meaning on those three fixtures:

| Synthetic case | Whole passages | Prompt tokens | Observed result |
| --- | --- | --- | --- |
| Mixed reports and request | 2 | 595 | Assistant-reported parser fix and 12 passing tests; user-requested export with an unrecorded implementation result; dates preserved |
| Count without work | 1 | 539 | Exact empty answer and empty sources, without repeating the incidental count |
| Recent record, old work | 1 | 579 | August assistant completion report remains historical; October user rollback/reimplementation report remains current and is not changed into a request |

The two positive outputs passed citation/language validation. The intended empty
output was rejected as insufficient answer evidence by the unchanged validator;
it is an abstention control, not a successful generated answer. No validator was
loosened to accept an incidental count or missing evidence.

That historical candidate's Korean rendered policy SHA256 was
`31ff459d8d7e80458c8acbbcd5ed0f1702db536f99b2026b22ea20e2afb42dd9`.
Its native policy rendered byte-identically to the comparison candidate;
speaker guidance was localized for Korean, English and Japanese. This historical
comparison used an explicit policy override. It does not establish that later
compiled policies or the installed application produce acceptable answers.
Factual and work-advice policy files were not changed by this activity policy.

These three inputs establish their semantic checks, not correctness on every
private note, complete coverage, multilingual model quality or device latency.
The synthetic fixed period is an evaluation fixture, not the product default.
At that stage, installed-application verification remained in progress. The
later installed failures are recorded below. Private note bodies, identifiers,
paths, screenshots and generated private answers are excluded from this report.

## Installed baseline: failed semantic verification

Version 0.4.0 was replaced at 23:01:39 KST on October 7. Its executable SHA256 was
`7ba066e6a23563cbbf15db85b7546d6a14b2bbeb529eda97b6eb251814391d9c`.

The exact reported question, explicitly scoped to wiki with Qwen 4B, initially
selected September 1 through October 7 and ended in a generic failure. A separate
native read-only probe selected 12 passages from 64 scanned pages and 3,165
matched chunks, with zero heading-only passages. Prompt preparation admitted
four sources at 1,752 tokens; generation returned complete, accepted JSON with
132 answer characters. These are retrieval and validator measurements, not
semantic validation of the private answer.

A fresh installed retry then asserted a single instruction-file edit request
and indicated incomplete coverage. The source panel showed imported standing
engineering rules and a partial earlier local-model preview near the generated
wiki lead, with the complete original source evidence farther down the page.
That response failed the activity-summary quality check. It did not demonstrate
that the requested personal-work overview was complete or correct.

## Evidence selection changes and current checks

The revised recall path excludes generated previews, generated lead text and
footers from source evidence. It fails closed when a generated page contains no
usable original quotation. It prefers the latest quotation block while keeping
the order of turns within that block. A standalone turn header and its adjacent
body are selected together, preserving their attribution and date relationship.
These structural changes address the observed selection failure; they do not
by themselves prove the model interprets the remaining evidence correctly.

Before the atomic header/body selection change, a read-only preparation
comparison admitted two pages at 1,663 prompt tokens with a 2,048-token context,
and six pages at 3,674 prompt tokens with a 4,096-token context. Those preparation
figures exclude answer generation and do not establish semantic quality or
complete coverage. The current activity context is 4,096 tokens and the output
limit remains 192 tokens, not 256.

Recorded checks after the strict header handling passed 1,163 native tests with
15 ignored, and 4,810 frontend checks across 333 files. A subsequent Clippy check
found a clone-to-slice lint in test code; its correction and final check belong
to the pending verification. A bundle build compiled successfully around
00:00 KST on October 8. That build result does not mean the latest changes have
been installed or verified in the application.

## Compiled policy probe: still failed

The subsequent real Qwen 4B run used five synthetic cases without a policy
override. The rendered compact-policy fingerprint began `e66e4f23`.

| Synthetic case | Semantic review |
| --- | --- |
| Incidental count without work | Correct abstention |
| Standing rules without an action report | Correct abstention |
| Mixed completion report and request | Preserved the core 12-test completion meaning |
| Historical completion followed by rollback | Invented a currently-in-progress state |
| Work spanning two recorded days | Collapsed separate dates into one day |

The last two outputs make this candidate a semantic failure. Earlier variants
also failed; candidate 4's three-case result above remains historical evidence
only. Passing JSON, citation validation, tests or compilation has not been
substituted for answer quality.

## Event framing regression checks — October 8

Three regressions failed before the correction: separate dated speech was
flattened, a standalone header was not attached to its verified adjacent body,
and ordinary prose mentioning roles was mistaken for an attribution-only chunk.
All 31 targeted synthesis tests passed after the correction.

Activity-only payloads now retain explicit date/role boundaries as separate
quoted event spans. Concatenating the record prefix, original attribution and
passage spans reconstructs the full source byte-for-byte. No text is omitted or
replaced with a fabricated fact. Exact speech-act labels are retained only when
present. A header supplies context to a body only when both selected chunks are
on the same page and adjacent. Source identities, original evidence, revision
checks and citation validation remain unchanged. Ordinary, factual and
work-advice payloads retain their existing representation.

The policy also distinguishes a need or to-do from an explicit progress report.
That constraint addresses the observed invented ongoing state; it does not
prove that the model follows the constraint on every record.

The final real-model comparison completed without an override. Installed
verification of that build subsequently failed, as recorded below.

With event framing and the progress-state policy in place, `cargo test
--all-targets` passed 1,166 tests with 15 ignored across 21 test targets. The
benchmark smoke targets completed. All-targets Clippy with warnings denied,
`cargo fmt --check` and `git diff --check` also passed. Frontend production code
did not change after the 4,810-test run. These historical checks validate code
boundaries, not the later installed answer quality.

### Compiled event-framed Qwen 4B comparison

The production release probe used 4,096 context and 192 output tokens with the
verified installed 4B weights. The rendered Korean policy SHA256 was
`fb4e99f6b591809eff9fb3d47bcc098d53c3bebbc775fd308ad111afb047399d`.

| Synthetic case | Semantic review |
| --- | --- |
| Mixed completion report and request | Preserved assistant attribution, 12 passing tests and the user's export request with unrecorded implementation result |
| Incidental count without work | Exact empty-answer/empty-source abstention |
| Historical completion followed by rollback | Preserved historical August assistant report and October user rollback/reimplementation requirement; no invented ongoing state |
| Standing rules without an action report | Exact empty-answer/empty-source abstention |
| Rules plus work spanning two recorded days | Excluded rules, retained the duplicate-filter report with eight passing tests, the export request and unrecorded outcome; cited the two work sources |

The fifth response omitted the assistant report's October 7 date. Its first
sentence begins with the October 6 user request and joins the undated assistant
report, so date scope remains ambiguous. It no longer claims that the export
request happened on the same day as the October 6 request. The core action,
actor, outcome and source checks pass; this is not a complete timeline-accuracy
pass. This limitation remains visible rather than being counted as universal
model correctness. The two intentional abstentions remain rejected by the
unchanged nonempty-answer validator.

## Updated installation — October 8, 00:11 KST

The new 0.4.0 bundle was installed at 00:11:03 KST. Executable SHA256:
`68e8a4d4171a8f02f29e444bc5dbf39fbae2b6bf9329192ab61f69a67f617cbf`.
The installer checked build/source fingerprints, strict deep ad-hoc signature,
bundle identity, policy bytes, command registration, the unchanged E5 artifact,
23 mascot assets and four preparation masters. The previous application was
backed up before replacement. Temporary tracing was absent.

Initial installed-window verification was blocked by the computer-use
connector: app selection and retry returned `Sky Computer Use native pipe
startup failed`; inventory returned no apps with the same error. This differed
from an app window not being found. No source permissions were broadened and no
alternative UI automation was used.

The user's October 8 installed results then established two failures of the
recent-work question. Wiki scope ended in generation failure. All scope
returned a generated answer dominated by assistant worker handoffs, internal
repair plans and test/process reports rather than useful work themes and
outcomes. Those results are failed installed verification, not an untested
window or an acceptable personal-work summary. The user's original next-work
question has not been reverified in this installation. No private screenshot,
record identifier, note path or answer body is reproduced here.

## Work-theme correction — October 8, not yet model-verified

The current uncommitted activity-only policy and localized reminders group
related records by the actual work, user-facing effect, reported result and
explicit follow-up. They omit worker handoffs, internal function/file IDs,
test-name lists and coordination chatter as separate work themes. Meaningful
measurements such as passing-test counts remain evidence for outcomes. A
single supported theme is valid; two to four themes are requested only when
the evidence supports them, within four short sentences.

Speaker provenance can be qualified once for the summary rather than repeated
in every sentence. Requests, proposals, reported completion and remaining
verification stay distinct. Event framing, original source spans and IDs,
revision checks, untrusted-evidence rules, empty-evidence behavior and citation
validation remain unchanged. The factual and next-work policies are unchanged.

The new theme-policy regression failed before the correction. All 32 targeted
`local_synthesis::tests` passed after it. The fallback-related targeted frontend
checks passed 203 tests. These focused results do not replace a full gate run or
semantic installed-model review of the changed policy.

The synthetic activity probe now contains six cases. The sixth combines
multiple internal worker handoffs with two related user-facing features,
reported 12/eight-test results, an unconfirmed proposal and request, and pending
installed-app verification. Its expectations require useful work themes,
preserved status/provenance and complete supporting citations. The previous
five fixtures were not weakened. This six-case Qwen 4B probe has not yet run
with the new policy, and the policy has not passed installed-answer semantic
verification.

## Codex session-organization sample — October 8

The user requested using the currently authenticated Codex CLI to organize
existing sessions. A short recent human-shaped session with a completed
assistant report was selected instead of the longest transcript. It has one
existing source-summary target. The source SHA256 was checked, and all ten
ordinal-aligned turn timestamps explicitly fall on one recorded day; document
or filesystem dates were not substituted for action timestamps.

One Codex CLI sample completed in 138.4 seconds. Its JSON structure and exact
supporting quotations passed validation. An independent full-source semantic
review also passed: work themes and user-facing results were useful, proposed
design was distinguished from reported implementation and verification,
synthetic/unconnected data limits remained explicit, and concrete remaining
issues were supported. It did not invent deployment, dates or the user's
independent completion. The overview was supported by its work items rather
than being a worker coordination log.

This is a single-sample result, not full-corpus verification or a Qwen 4B
quality result. Bulk publication and continuing-session organization remain
incomplete. The existing Wiki path should be reused with current-byte checks;
existing user content, source evidence, citations and raw originals must remain
preserved. No private session body, identifier, path or generated answer is
included in this report.

## Continuous organization and current semantic gate — October 8

Explicit MCP imports now enter a revision-verified automatic queue. A stable
conversation key resolves its existing summary path; immutable title-only
revisions retain earlier sources and human annotations. Duplicate summary
identities fail closed. MCP page updates accept an optional expected SHA-256,
and creates require absence. The revision guard coordinates in-process writers;
it is not a global transaction with external editors.

The current frontend gate passed 335 files and 4,894 tests, TypeScript build,
production Vite build and scoped ESLint. MCP regressions passed 115 tests,
including seven new stale-write, concurrent-create, path-confinement and
duplicate-identity checks; six related vault-writer checks also passed.

The subsequent full native gate passed 1,180 library tests with 11 ignored but
failed the existing `archive_resolution` integration test. A legacy flat raw
citation stopped resolving after its source moved to the archive. The failure
is being corrected while retaining strict immutable revision and confinement
checks; the full gate has not yet passed.

A second bulk-organization sample initially failed independent full-context
review because two major work themes were missing. Its supporting quotations
were exact, which did not establish summary completeness. The sample was
repaired without changing unrelated records, and a fresh review bound to the
exact input and result hashes passed with zero findings in 111.0 seconds. This
is a sample-level result. Bulk publication remains gated on the corrected
sample's guarded write and the new installed MCP capabilities.

The six-case compiled production Qwen 4B probe then returned accepted JSON for
all six cases, but semantic review failed. Inventory-only and rules-only
controls produced nonempty answers. The worker-coordination fixture conveyed
the two user-facing effects and reported test counts, but included handoff-only
sources and described unrecorded requests/proposals as an ongoing planning
stage. Report attribution also remained insufficient. These results require a
further activity-only correction and do not validate the installed application.

## Final source gate and remaining model failures — October 8

The archived flat-source citation regression was corrected without accepting
ambiguous, nested-revision or symlink targets. The final all-target native gate,
including the new activity JSON field-order regression, passed 1,215 tests with
15 ignored across 21 targets. All-target Clippy with warnings denied and the
format check passed. The frontend gate remains 4,894 passing tests across 335
files, with TypeScript, production Vite build and scoped ESLint passing.

Activity generation now places its final eligibility, status and citation
reminder after the evidence, using JSON escaping without changing the evidence
values. Factual and work-advice policies and all six activity fixtures remain
unchanged. The final compiled production probe used the verified installed Qwen
4B weights: JSON and existing output validation accepted all six responses, but
independent semantic review passed only one of the six cases. Missing outcomes
were still presented as ongoing work, a required work source was omitted, and
inventory-only or standing-rule-only controls did not return the requested
empty result. These are unresolved answer-quality failures, not passing tests.
Mean generation time was 9.97 seconds, with a range of 7.45–14.69 seconds;
artifact verification took 11.52 seconds separately. These synthetic timings
exclude retrieval, period planning, UI and actual-vault answer verification.

Additional Codex organization reviews covered one complete multipart record
and two other single-part records. Two passed on first review; one omitted a
major theme, was repaired, and then passed fresh full-context review with zero
findings. The correction retained exact original quotations and unrelated job
results. Sample reviews do not establish semantic completeness for every
session, and generated results are not published solely because their JSON
and quotation checks pass. Bulk processing, guarded publication and actual
installed-vault answer verification remain separate work.

## Installed verification and next-work retrieval — October 8

The subsequent header-scan budget correction reserved capacity for complete
pages and immutable source checks. Its build was installed at 12:51 KST.
Native window control became available, so both reported questions were run
in the installed application with the All scope and the existing Qwen 4B
provider. The recent-work question selected October 1–8 through the model.
Its answer still failed review against the complete cited pages: it overstated
some results and remaining-work status and omitted substantial themes. This
review did not capture the exact generation prompt or inspect the entire
vault, so it is a cited-page review, not a corpus-wide recall measurement.
The next-work question retrieved one unrelated record and returned no useful
recommendation. Neither installed answer was accepted as a quality success.

Topic-free next-work questions now use the same model-selected historical
period and date-grounded recall path as recent-work questions. Explicit scope,
selected source paths, Stop and source-revision checks remain in force. The
advice policy takes precedence over the retrospective summary policy, and the
historical period does not become a deadline for suggested work. The exact
reported Korean question first failed the new routing regression and then
passed after this correction. Topic-qualified questions retain their existing
search route.

The updated frontend gate passed 4,908 tests across 335 files, TypeScript,
production Vite build and scoped ESLint. An initial unrestricted native run
failed the existing quarantine-undo and HTTP-redirect tests. Both passed alone
without code or assertion changes. The subsequent complete all-target run
with two test threads passed 1,223 tests with 15 ignored across 21 targets;
Clippy with warnings denied and formatting also passed. The initial failure
logs were retained. These results support the code paths, not answer quality.

The new bundle was installed at 13:28 KST with its strict ad-hoc signature and
unchanged bundled E5 artifact verified. macOS then requested renewed Documents
folder access because the application's code requirement changed. The native
permission dialog is inaccessible to the screen-control tool. Actual-vault UI
verification of this build is pending that permission; the application waits
while opening the vault.

The compiled four-case next-work probe used the same installed Qwen 4B weights
and the dated production prompt. All four outputs passed JSON/source-ID
validation, but semantic review found material failures: the undated plan
received no practical next step, and completed work with unrecorded follow-up
was incorrectly turned into an absence of remaining work or ongoing plans.
The explicit-priority case followed the recorded ordering. Mean generation
time was 20.79 seconds (17.20–25.11 seconds), with 19.66 seconds of initial
artifact verification separately. These synthetic measurements exclude
retrieval, period planning and UI. A shorter advice policy is being evaluated
privately; it has not been accepted or shipped on these results.

## Controlled Korean advice evaluation and session updates — October 8

The shorter Korean advice policy was subsequently compared using the same
verified 4B weights, original sampler and production 4,096-token dated context.
Four development cases and six additional synthetic cases covered plans,
recorded priority, completed work, missing goals, requests without outcomes,
explicitly pending manual verification, rollback, mixed completed/requested
work, inventory-only evidence and changed priorities. All ten outputs passed
JSON/source validation. Review of these cases found that they retained the
tested completion, unknown-outcome, cancellation and ordering distinctions.
Some first steps remained generic, and one output used awkward Korean wording;
this is not a claim that arbitrary recommendations are correct or useful.

Mean generation time was 12.70 seconds (9.23–16.93 seconds), excluding artifact
verification, retrieval, period planning and UI. The accepted policy's SHA-256
is `a6e996bb3f19e161987b6971b29782b1c4fb1501828ba4767e6befdf6e3959f4`.
The Korean policy is now selected in source only for explicit next-work
questions. Its prompt bytes match the evaluated policy. English/Japanese
recommendations and ordinary factual/status prompts retain their policies.
The example's `--recommendations-only --advice-holdouts` option reproduces the
six additional cases with installed verified weights.

An isolated lower-temperature/presence-penalty variant still misread unrecorded
requests as unfinished and therefore was not adopted. A longer Korean advice
variant regressed on cancellation and completion; two Korean activity-policy
variants also retained material status or relevance errors and were not
adopted. Synthetic JSON acceptance alone did not qualify any of those variants
for installation. Retrospective activity-summary quality remains unresolved.

A separate regression reproduced a continuity bug: appending new evidence to
an already organized session left its original-date discovery metadata stale.
Updates now retain earlier dates and add only original document dates and
explicit dates from saved source chunks. Organization time and the renderer's
fallback date do not become activity dates. Targeted frontend checks passed
109 tests and the native search regression passed; invalid, missing,
misaligned and duplicate turn metadata stay unpromoted. Existing generated
sections, custom titles and human annotations remain unchanged.

These later source changes initially awaited verification in the installed vault.
Their complete gates passed 4,915 frontend tests across 336 files, TypeScript,
Vite and scoped ESLint, plus 1,224 native tests with 15 ignored across 21
targets at two test threads, Clippy with warnings denied and formatting.
The updated bundle was installed at 14:20 KST with executable SHA-256
`5d509813d68db84addcf1e5ef20c3703e6b348a62a6cb9876528b2087e770dbc`.
Build/source fingerprints, the Korean recommendation policy bytes, strict
ad-hoc signing, the unchanged E5 artifact, 23 mascot assets and four preparation
masters were checked before replacement. Both the previous application copy
and previous live bundle were retained. The initial zero-note loading state
waited for renewed Documents access. The user subsequently granted access;
runtime vault checks passed and a normal application restart restored the
existing notes. The screen-control tool's refusal to operate the permission
application was respected; no permission database or security setting was changed.

A separate bounded-thinking experiment used the same 4B weights with at most
512 thought tokens followed by constrained JSON output. Its first synthetic
activity case took 83.46 seconds and returned an empty answer. The inventory-only
control also completed in 80.49 seconds with an empty answer; that abstention was
appropriate. Later cases were not run: the owned probe process was stopped and
the experiment was rejected. Neither its sampler nor thinking mode was installed. Its changes and
results were archived before removing only the experimental worktree; existing
foreign worktrees and the three user stashes were preserved.

## Completed session publication and context regression — October 8

All 372 human-record batches and all 47 multipart reductions completed. The
last failed batch was retried with exact-quote validation and reconciled only
after the original producer exited. The final canonical catalog contains 1,680
sessions: 255 work pages, 1,422 process sessions and three empty sessions.
Another 31 source documents without a canonical session identity remain
separate. The topic map links all 255 published work pages, with no pending
or held groups. Original files and annotations were preserved. Original-quote
and source-revision checks passed for all 830 human-classified final records;
this is not a universal semantic audit of their generated summaries.

With 254 work pages already published, the 14:20 installation answered both
reported questions in the All scope. Recent work took 98.151 seconds end to
end and next-work advice took 71.249 seconds. Neither passed semantic review:
the first introduced an unsupported end-of-month date and omitted major work
themes; the second proposed documentation work already reported as complete.
The recent-work review used complete cited pages, not the exact generation
prompt. These two timings are observations, not an average-time guarantee.

A subsequent read-only reproduction against the final catalog captured the
production prompt privately. Both questions selected six passages; recent-work
and advice prompts used 2,452 and 2,280 tokens respectively. The passages favored
recent result/test reports and omitted selected follow-ups. This reproduction
used the observed date ranges and current index, not a byte-identical snapshot
of the earlier UI requests. A synthetic regression additionally demonstrated
that an attribution/body split consumed both per-page chunk slots and removed
the remaining-work quotation.

Retrieval now counts complete curated quotations and retains each page's
outcome/follow-up selection together. Prompt budgeting accepts up to the existing
12 retrieved chunks for activity questions and preserves each curated page as
one selection; the token, source-hash, date, scope and original-quote checks
remain enforced. Ordinary factual questions retain their six-chunk limit.
Citation labels now use organized titles from the same open vault, without
changing verified link targets or borrowing metadata during vault transitions.

The opt-in ignored `local_generation::private_probe::inspect_activity_context`
test reads only explicitly configured vault/index paths, revalidates sources,
uses verified model weights and writes complete diagnostics to a new private
file. `MYCO_ACTIVITY_PROBE_CONFIG` selects its JSON configuration; a test run
also requires an explicit `MYCO_DATA_DIR`. It is excluded from application
builds. Actual installed-answer verification of the context correction is
still separate from its passing regression tests.


## Compiled session context correction — October 8

Three subsequent exact-prompt replays still failed semantic review. Complete
quote selection, readable project titles and newest-event page ordering helped
retrieval but did not stop invented dates or incorrect status transitions. The
third replay also exposed a citation grammar limited to S1–S6 despite selecting
up to 12 activity passages. A successfully built candidate from that stage was
retained without installation; its semantic failures were not called a fix.

The next correction consumes existing compiled work and remaining-task statements
instead of asking the small model to reconstruct them from a few selected quotes.
An optional version-one `myco:codex-session-context` marker binds visible statement
text and supporting quote IDs to the exact existing proof JSON. Native code
rechecks the original source revision, quote bytes, actor and explicit date under
the unchanged read budget. Every quote supporting a retained statement must be
inside the requested period. Client-supplied compiled statements are discarded.
A retrieved passage outside the compilation prevents it from hiding a newer
appended original. These checks establish provenance and revision consistency,
not independent semantic truth or complete corpus coverage.

Compiled pages enter the prompt once, retaining work and remaining statements
together. Korean activity/advice prompts use those secondary records explicitly.
The selected date range remains in the UI; it is omitted from the compiled prompt
to avoid turning a retrieval boundary into a claimed work date. Activity output
initially allowed 256 tokens within the existing 4,096-token context; factual questions retain
192 output tokens and their 2,048-token context. The JSON grammar permits S1–S12,
while post-generation validation still rejects identifiers outside the prompt.

The first full library check reported one obsolete 192-token expectation after
the activity-only cap changed to 256 (`left: 256`, `right: 192`); the expectation
was updated for that explicit behavior. The subsequent all-target native run
passed 1,231 tests with 16 ignored across 21 targets. Frontend activity/synthesis
checks passed 117 tests. The later attribution-header regression passed with
1,203 library tests and strict all-target Clippy. Actual model and
installed-answer checks are separate.

All 255 published work pages received the bound context marker. A guarded sample
preceded the remaining 254 updates; removing only the added marker reproduced
each previous owned section byte for byte. The topic map still linked 255 work
pages with no pending or held groups. Existing originals, annotations and
accepted immutable revision bindings were retained. The installed application's
reader opened the map and displayed those counts.

The first compiled-context replay used a stale saved search index. Original
revision checks excluded the changed pages, causing a raw-fragment fallback and
an empty second request (`invalid synthesis evidence budget`, test exit 101).
That run does not measure the compiled prompt. The normal Settings reindex
completed for 1,421 pages; later automatic updates increased the visible count.

After reindexing, exact production-prompt replays selected four compiled pages.
The final replay took 18.706 seconds for synthesis of recent work and 16.987
seconds for next-work advice. These exclude period planning, retrieval and model
loading. Both completed JSON validation, but neither passed semantic review:
the summary repeated a writing instruction and omitted material limitations;
the advice mentioned a third source while declaring only two citations. Passing
the diagnostic test means it captured the run, not that its answer was correct.

A shorter-policy comparison produced more natural but incorrectly attributed
status statements and was rejected. Its 256-token outputs also ended before the
JSON closed. The activity output allowance is now 768 tokens, with that full
reservation enforced inside the unchanged 4,096-token context. Factual questions
remain capped at 192 output tokens. There is still no automatic Ask deadline;
manual cancellation and source revalidation remain in place.

A test-only 512-token reasoning comparison on compiled records also failed:
recent-work output was rejected and advice became less specific. The experiment
was archived and removed from the source. No thinking-budget environment hook
or diagnostic prompt override is enabled in the application.

The final frontend suite passed 4,920 tests across 336 files. ESLint reported
zero errors and two existing `notchDriver.ts` dependency warnings. The final
native all-target run passed 1,231 tests with 16 ignored; formatting, strict
Clippy, TypeScript and the macOS bundle build passed. The bundle was installed
at 16:44 on October 8 with a reversible backup, a verified ad-hoc signature,
unchanged E5 weights and all 23 frontend mascot assets.

An isolated Qwen3.5 9B Q4_K_M comparison used identical production prompt
contents and original-source revision hashes. It took 28.387 seconds for recent
work and 27.288 seconds for advice, excluding setup and retrieval. The summary
retained the mock-data limitation and all four citations. Advice still treated
historical unknown outcomes as current unfinished work and lacked a concrete
first action. This candidate was not accepted or selected in the application;
the selected Ask/import model remains 4B. These are two observed cases, not an
average latency or general model-quality estimate.

The opt-in probe's `comparison_model_dir` uses the same native size, SHA-256,
regular-file and revision checks for the pinned 9B artifact. The test-only
manifest names revision `1379f25c6b505a3fc737bd7818cb09389cf807c1`, 5,627,044,256
bytes and SHA-256
`cd76ec205963b3b33350093e6904d9de16c4e666fd104e1f632d25c7f15f2a13`.
Its chat template matches the already-supported 4B template exactly. Sources:
[Qwen model card](https://huggingface.co/Qwen/Qwen3.5-9B) and
[pinned conversion](https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF/blob/1379f25c6b505a3fc737bd7818cb09389cf807c1/Qwen3.5-9B-Q4_K_M.gguf).

Installed startup exposed an independent responsiveness defect. The main thread
waited for the reader's synchronous authorship query while its read-only
`git ls-files` child waited in `getcwd`/`open`; a second history reader also
waited. Restart reproduced the hang. Terminating only those owned read-only
children immediately restored window responses. `page_authorship` now uses
the existing blocking-worker adapter, retaining path confinement and error
propagation. The library suite passed 1,203 tests with 12 ignored and strict
Clippy after this change. Final installed startup and answer checks remain
separate from these code checks.

The follow-up bundle was installed at 17:00 on October 8 (binary SHA-256
`3517b01d8a17e310e88abeabebf56af024a93280606a927d0364b9ef362dc54a`).
Its main window and Settings responded normally without terminating child
processes. The selected vault path remained unchanged, but the app displayed
zero notes while the original map and its 255 links remained readable on disk
from the development environment. Final installed answer verification therefore
has not completed. The screen tool refused access to the macOS permission
notification application with `safety reasons`; a new-install Documents-access
check was requested from the user. No system permission was bypassed.
