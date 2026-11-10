# iPhone source records and evidence contract

Reviewed: 2026-10-04. Status: proposed connector contract, not a live connection or an iOS build result.

The first iPhone release should capture selected contacts, calendar events, and user-shared files into a read-only evidence pipeline. This document defines what a real adapter must preserve. It does not implement permission requests, native enumeration, pairing, OAuth, or background delivery. This host has Command Line Tools but no Xcode/iOS SDK; device permissions and native compilation remain unverified. The earlier [mobile feasibility research](../research/2026-10-01-ux-mobile/mobile-feasibility.md) describes another checkout and is planning context, not proof that this checkout builds on iOS.

Desktop Ask and local ingest remain extractive. The bundled E5 embedding model does not generate prose; an optional writer provider must be identified separately. No generation model is required by this contract.

## Capability boundary

These are platform capabilities, not implemented myco connectors. Runtime capability must be checked on the actual OS, account, permission state, and entitlement.

| Source | Ordinary iPhone app, Korean account/device | Adapter boundary |
| --- | --- | --- |
| Contacts | Selected or fully authorized contacts through `CNContactStore` | Preserve limited access. Do not request the separately controlled contact notes field by default. [Contacts access](https://developer.apple.com/documentation/contacts/accessing-the-contact-store) |
| Device calendars | EventKit full access can fetch events; write-only access cannot | Request read access only when the user enables reading. Record the selected calendars and query window. [EventKit access](https://developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui) |
| Google Calendar | Separate Google OAuth/API connector, or a calendar already exposed by EventKit | Do not count the same event as two independent facts. Account/API identity is not implied by device permission. See the [Google sync contract](../research/2026-10-04-google-sync-contract.md). |
| Gmail / iCloud Mail | Separate provider-authorized API/IMAP adapters or an explicitly selected export | Both are selected targets. Apple Mail is not a general mailbox-reading API. Gmail needs OAuth scopes; iCloud's documented first path uses TLS IMAP and an app-specific password. Device contact/calendar permission grants neither mailbox. [Google contract](../research/2026-10-04-google-sync-contract.md), [iCloud Mail contract](../research/2026-10-04-icloud-mail-contract.md) |
| SMS / MMS / RCS / iMessage history | No supported full-history importer for an ordinary Korean iPhone app | `TelephonyMessagingKit` is a different, entitled default carrier messaging role with EU account/device conditions. It handles carrier messages while configured and is not an old iMessage archive API. [Carrier messaging](https://developer.apple.com/documentation/telephonymessagingkit/creating-a-carrier-messaging-app) |
| Carrier call history | No supported general past call-log importer for this target | The entitled default dialer can access history beginning when it became the default; Apple's setup/test requirements include the EU account/device condition. CallKit integration is not permission to read all past calls. [Default dialer](https://developer.apple.com/documentation/livecommunicationkit/preparing-your-app-to-be-the-default-dialer-app) |
| Call content / recordings | No promise of automatic carrier audio access | Treat an explicitly shared recording or transcript as a manual source, with its real provenance. A call-log entry is not its spoken content. |
| Other apps' notifications | No general iOS notification-history collector | A share extension receives a user-selected payload, not the originating app's whole archive. [Share extensions](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html) |
| Background collection | System-scheduled opportunities and foreground resumption | Persist checkpoints; do not promise a permanently running collector or a fixed polling interval. [Background Tasks](https://developer.apple.com/documentation/backgroundtasks) |

EU-specific messaging/dialer APIs must not appear as enabled features for the selected Korean target. Sideloading does not remove framework access controls. A capability screen should distinguish `available`, `permission_required`, `limited`, `write_only`, `unavailable`, and `not_implemented`, with the last successful completed read. “Connected” requires successful authorization and an actual source read.

## Record identity and revisions

Use a source-scoped key, not a filename, name, phone number, email address, event title, or import date:

```text
record_key = connector + opaque_account_or_device_id + collection_id + external_record_id
revision_key = record_key + content_sha256
```

This is a proposed application contract, not a claim that all providers expose equivalent IDs. Each adapter must document its identity guarantees. A Contacts identifier identifies that contact within its store; it is not a universal person ID. Store resets, migration, and explicit relinking need reconciliation rather than automatic merging by matching display names. Two contacts with the same name remain separate until the user links them.

For calendar occurrences, preserve the series ID and original occurrence start independently of the possibly rescheduled start. Retain the provider's occurrence ID when present. For Google Calendar, preserve `id`, `iCalUID`, `recurringEventId`, and `originalStartTime`; these have different meanings. An EventKit record and a Google API record require an explicit verified identity bridge, not deduplication by title and time. [Google event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)

Preserve original payload bytes with an actual SHA256 and, separately, a deterministic semantic revision. The semantic representation must have a documented field order/normalization and exclude observation time, pagination tokens, and transport order. Preserve meaningful array order. A replay with the same record and semantic revision is a no-op; a changed revision appends evidence and queues affected derived knowledge. Hash equality establishes content identity, not factual correctness or user intent.

An opaque provider ETag or revision token is retained for preconditions but is not sorted lexicographically to decide which revision is newer. A delayed old export cannot silently replace the current provider observation. If provider version order or authoritative update time is unavailable, retain both observations and mark their ordering unknown.

## Proposed envelope

The smallest useful record contains the following; absent source facts stay absent:

| Field | Meaning |
| --- | --- |
| `schema_version`, `connector`, `record_key` | Versioned contract and source-scoped identity |
| `kind`, `operation` | For example `contact` / `calendar_event`; `upsert` or an explicit provider `tombstone` |
| `collection_id`, `external_record_id`, `provider_revision` | Opaque native/provider identity, with provider revision only when supplied |
| `content_sha256`, `original_sha256`, `original_path` | Semantic revision, exact original bytes, and preserved source reference |
| `occurred_at`, `source_updated_at`, `observed_at` | Real-world/source time, provider update time, and adapter read time; no substitution between them |
| `time_zone`, `all_day_start`, `all_day_end_exclusive` | Source zone when known; date-only boundaries for an all-day interval |
| `payload`, `provenance` | Typed source fields and adapter/source/permission/window references |

Validate every runtime envelope before persistence: bounded lengths and payload size, supported schema/kind, actual SHA256 syntax, valid timestamps and date-only values, and confined relative paths. Native IDs are data; they must not become filesystem paths or shell arguments. Credentials, raw authorization tokens, and account email addresses used only for authentication never belong in the record or model input.

Preserve offset-bearing source timestamps and the IANA time zone when supplied. `observed_at` is never evidence of when a meeting, message, or decision occurred. An unknown event or turn time remains unknown. Do not infer it from the import date or a nearby turn.

All-day values remain `YYYY-MM-DD`, with an exclusive end. A one-day event from `2026-10-04` to `2026-10-05` must not be converted to midnight UTC and then shifted into another day. Retain recurrence rules and source zones across daylight-saving changes. Google explicitly defines the event end as exclusive and separates all-day dates from timed date-times. [Google event dates](https://developers.google.com/workspace/calendar/api/v3/reference/events)

## Batch scope, permissions, and deletion

A separate batch receipt records the selected source/collection, permission state, query window, continuation/checkpoint, counts, failures, and whether the requested scope was fully enumerated. It is not a statement that the whole device was read. Contact `limited` access and calendar windowed access are normal partial scopes.

Persist validated records and their promotion queue before advancing the adapter checkpoint. A failed page, revoked permission, missing file, expired token, or background expiration leaves a resumable partial batch. Do not label it complete because the first page or the first summary was saved.

A missing record in a limited/windowed/failed read does not prove deletion. Append a tombstone only for an explicit provider deletion or a verified complete reconciliation within the same authoritative scope. Removing a contact from the allowed selection is permission loss, not proof that the contact ceased to exist. A cancelled recurring occurrence is separate from cancellation of the whole series.

Google cursor reset rebuilds the managed active view; it does not delete historical vault evidence. Google Calendar's incremental protocol emits deletions and places the next sync token on the final page; token invalidation requires full synchronization of that managed view. [Calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)

Background interruption must not advance either the source checkpoint or the source-coverage receipt beyond durable work. The foreground app resumes from the last committed batch. Start with foreground/manual refresh before promising background freshness.

## Handoff to existing knowledge processing

The implemented desktop boundary is `src/lib/sessionEvidence.ts`, used by session digest, rollup, and extractive ingest. It accepts a vault-relative source path, complete Markdown, and a legacy date fallback; emits bounded evidence chunks; and validates revision-specific coverage receipts. It is not itself a connector or permission manager.

An eventual native adapter should project validated records into readable source Markdown with original titles, typed dates, operation/revision provenance, and exact source text. Conversation exports retain role headers and ordinal-aligned `turn_metadata`; a metadata-present turn with no timestamp must remain undated. Calendar/contact records must not masquerade as user decisions or assistant task completion.

Ingest uses at most 48 evidence chunks per pass, preserves overlap and full quoted chunk text, and resumes uncovered chunks in later passes. `sourceEvidence`'s current FNV32 fingerprint is a progress identity, not the connector's SHA256 integrity proof. Keep the actual original/semantic SHA256 in native source metadata and compare it before commit. Inline citations are supplied to `evidenceSection` before its evidence hash is computed.

The bounded overview is only a preview. Completion requires valid persisted coverage of every actual chunk for the current source revision, including the tail. A marker without retained quote evidence does not establish coverage. A saved source may therefore be durable while its knowledge promotion remains pending.

Derived topic/person/decision pages should reference these revisions and evidence spans, using existing journal and ADD/UPDATE/MERGE/NOOP boundaries. Source mention flags identify quotes to review; they do not prove a decision was adopted or executed. Preserve earlier and later states with their source dates. Do not silently rewrite a hand-edited page to match the last imported sentence. Native `write_file_if_unchanged` checks exact SHA256 bytes (or file absence) under the same process lock as normal app saves. `writeEvidenceNote` rebuilds from the latest note after a conflict, with at most three attempts. External editors, other processes, and device synchronization do not share this lock; this is not filesystem-wide compare-and-swap. Reading the latest note alone is not a complete concurrency guarantee.

Existing vault `raw/` is immutable, including manual operations. A connector must not use it as an unlimited permanent mailbox dump. A managed account-source cache needs its own approved retention, disconnect, and erasure contract before activation; see the [Google sync and data-use contract](../research/2026-10-04-google-sync-contract.md). Account disconnect, provider deletion, source permission loss, and user-requested data erasure are distinct states. Neither a resync nor a wiki cleanup may silently mutate existing raw evidence.

## Acceptance checks before enabling a connector

Use synthetic records only:

1. Replay one record/revision twice; ingest and promotion are idempotent. A changed revision retains both evidence versions and creates one new pending promotion.
2. Import an older revision after a newer observation; current-state answers do not regress silently. Unknown version order remains explicitly unresolved.
3. Give two accounts identical external IDs and titles; their records remain distinct. Link duplicate EventKit/Google observations only with an explicit identity bridge.
4. Change Contacts access from full to limited, then revoke access; absent contacts are not marked deleted. Errors and permission recovery are visible.
5. Import a rescheduled recurring occurrence and a cancelled exception; preserve original occurrence identity and suppress only the correct active occurrence.
6. Test a date-only event, an offset-bearing event, and a daylight-saving transition; display and date queries preserve the source's day/zone.
7. Stop between pages or during promotion; checkpoints and coverage resume without skipped tails, duplicate records, or false completion. Changing source bytes invalidates the old revision's pending receipt.
8. Fail authorization or expire a sync token; show reconnect/full-reconciliation state rather than an empty successful source. Raw history remains untouched.
9. Alter retained quote text or edit a derived note concurrently; coverage invalidation and the final write precondition prevent an invented complete receipt or lost user edit.
10. On a real iPhone, compile native adapters and test first request, denial, limited selection, full access, write-only calendars, background expiration, and foreground resume. Check actual touch UI and memory; desktop synthetic tests do not establish these results.

The next implementation milestone is one real read-only Contacts/EventKit adapter with permission UI, a bounded source read, durable staging, validated records, and a receipt visible to the user. OAuth, SMS/call history, always-on collection, synchronization transport, and native model benchmarks are separate work and are not completed by this specification.
