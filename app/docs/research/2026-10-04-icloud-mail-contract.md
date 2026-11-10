# iCloud Mail connector contract

Reviewed: 2026-10-04. Status: implementation design; no iCloud connector, live authorization, IMAP capability probe, or native iPhone validation performed.

The selected email sources are Gmail and iCloud Mail, with iPhone first and an Intel desktop with 8 GB RAM. Use separate provider adapters feeding one typed email evidence pipeline. This document specifies the iCloud adapter; it does not add account access or imply that the existing Gemini provider reads either mailbox.

## Verified access and authorization boundary

Apple documents IMAP access through `imap.mail.me.com`, port `993`, with SSL required and an app-specific password. The username is usually the address's local part; Apple advises trying the full address if needed. iCloud Mail does not support POP. SMTP exists separately and is unnecessary for this read-only feature. [Apple server settings](https://support.apple.com/en-us/102525)

App-specific passwords require Apple Account two-factor authentication. Users create them at `account.apple.com`; Apple permits up to 25 active passwords and individual or collective revocation. Changing or resetting the main Apple Account password revokes existing app-specific passwords. Never ask for or store that main password. [Apple app-specific passwords](https://support.apple.com/en-us/102654)

Apple also documents direct Apple Account authorization for **supported** third-party apps accessing Mail, Calendar, or Contacts. Users can revoke these grants under Account Data Sharing; unsupported apps use app-specific passwords. However, the reviewed materials do not establish developer registration, endpoints, scopes, PKCE, or token formats for our custom app. Do not invent a generic iCloud Mail OAuth implementation or assume every custom app qualifies. Establish that developer contract separately before offering this alternative. [Apple third-party data access](https://support.apple.com/en-us/121539)

Ordinary Sign in with Apple requests name/email identity information. It is not evidence of a mailbox grant. Its identity token must not be passed to IMAP as though it were a documented Mail access token. [Apple sign-in scope reference](https://developer.apple.com/documentation/signinwithapplejs/clientconfigi/scope)

The practical first milestone is app-specific-password IMAP. Proposed credential custody is a device/account-specific Keychain item on iOS/macOS. Do not place it in a vault, source payload, Markdown, browser storage, logs, Git, or model context. Synchronizing wiki evidence between devices does not authorize copying mailbox credentials to a relay or hosted worker. [Apple Keychain password storage](https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain)

## Read-only protocol and capability negotiation

Use implicit TLS with certificate/hostname validation; no plaintext or certificate-validation fallback. [RFC 8314, secure email access](https://www.rfc-editor.org/rfc/rfc8314.html)

Open selected mailboxes using `EXAMINE`, and fetch bodies using `BODY.PEEK[...]` so reads do not implicitly set `\Seen`. Block mailbox write commands and SMTP in this connector. These are client restrictions: Apple's app-password documentation does not promise a granular, server-enforced read-only scope equivalent to Gmail's OAuth scope. [RFC 9051, EXAMINE and FETCH](https://www.rfc-editor.org/rfc/rfc9051.html)

Inspect negotiated capabilities after authentication and keep them with diagnostic state without credentials. RFC publication is not proof of iCloud server support. Neither IMAP4rev2 nor `CONDSTORE`, `QRESYNC`, or `IDLE` has been verified against a live iCloud account here. Support a negotiated baseline before optional optimizations.

| Negotiated behavior | Proposed synchronization strategy |
| --- | --- |
| Baseline IMAP | Reconcile current UIDs, fetch new admitted payloads, refresh mutable metadata in bounded batches, and compare the completed UID set with the managed view. |
| `CONDSTORE` with persistent mod-sequences | Use `CHANGEDSINCE` for changed metadata; separately reconcile removed UIDs. |
| Enabled `QRESYNC` | Resume with prior UID validity, modification sequence, and known UIDs; process `VANISHED` as well as changed metadata. |
| `NOMODSEQ` for a mailbox | Discard that mailbox's mod-sequence checkpoint and use baseline reconciliation. |
| `IDLE` where supported | Treat notifications as wake-up hints; reconnect and reconcile using durable state. |

Baseline cache recovery and UID validity checks are described in [RFC 4549, disconnected synchronization](https://www.rfc-editor.org/rfc/rfc4549.html). The extension rows follow [RFC 7162, CONDSTORE/QRESYNC](https://www.rfc-editor.org/rfc/rfc7162.html). Optional IDLE notifications follow [RFC 2177](https://www.rfc-editor.org/rfc/rfc2177.html); they are not a durable event history.

## Identity, checkpoints, and deletion

Within a mailbox, durable identity includes `UIDVALIDITY` and `UID`; sequence numbers can shift after expunges. UIDs can have gaps, and `UIDNEXT` is a prediction rather than a guaranteed next message. Scope the identity to the connected account and mailbox. Do not identify messages by subject, import date, or sequence number. [RFC 9051, message attributes](https://www.rfc-editor.org/rfc/rfc9051.html)

When `UIDVALIDITY` changes, invalidate the managed mailbox cache and its UID references, then rebuild that mailbox's active view. Old UIDs must not be applied to the new namespace. This cache reset does not erase previously promoted immutable vault evidence. A conservative mailbox rename policy treats an unverified new name as a new collection and retains provenance rather than guessing identity continuity. [RFC 4549, UID validity recovery](https://www.rfc-editor.org/rfc/rfc4549.html)

For baseline sync, a successful `UID SEARCH ALL` supplies the reconciliation set; fetch admitted messages and flags by UID in bounded batches. A successful UID FETCH can return no data for a UID that no longer exists. [RFC 3501, UID commands](https://www.rfc-editor.org/rfc/rfc3501.html) Proposed resource/commit rules: stream large responses, retain the previous view after interrupted search/fetch, and reconcile disappearing UIDs rather than fabricating empty bodies or deletion batches.

For extension sync, calculate the next `HIGHESTMODSEQ` at tagged command boundaries, respecting an explicit server value rather than blindly taking the largest observed FETCH value. Delayed removals can otherwise be skipped. `NOMODSEQ` prevents use of `CHANGEDSINCE`/MODSEQ requests for that selected mailbox. MODSEQ is an unsigned 63-bit value; serialize it as a validated decimal string across the JavaScript boundary. [RFC 7162, checkpoint handling](https://www.rfc-editor.org/rfc/rfc7162.html)

Stage the complete reconciliation batch and payloads, then atomically publish the managed view, resumable promotion jobs, and checkpoint. Only one writer owns an account/mailbox checkpoint at a time. A failed page-equivalent batch, crash, parsing error, expired credential, or permission error leaves the prior successful checkpoint intact. Fetch completion and wiki promotion completion remain separate.

Expunged UIDs become mailbox-membership tombstones. A removal from one folder is not proof that the email disappeared from every folder or account; `\Deleted` is also distinct from expungement. [RFC 3501, EXPUNGE](https://www.rfc-editor.org/rfc/rfc3501.html) Remove obsolete membership from current-state retrieval and invalidate affected indexes/derived claims. Preserve evidence of old states with explicit provenance instead of presenting them as current.

## Proposed shared email record

The following fields are an app-owned contract, not Apple or Gmail API fields. Provider-specific identity and synchronization state remain typed inside their adapters; do not force IMAP cursors into Gmail's `historyId` protocol.

| Shared field | Meaning and boundary |
| --- | --- |
| `provider`, `connector_account_id` | `gmail` or `icloud-mail`; app-assigned stable account identity, with the credential reference stored separately. An address/alias is display metadata. |
| `remote_identity` | Gmail account + message ID; iCloud account + mailbox + `UIDVALIDITY` + `UID`. Encode structured fields without delimiter collisions. Gmail labels are memberships, not separate message identity. |
| `memberships`, `flags`, `state` | Current selected collection membership and provider metadata; `active`, `removed`, or `unknown`, updated by the connector's managed view. |
| `provider_sent_at`, `mailbox_internal_at`, `fetched_at` | Preserve distinct timestamps and original values; missing/invalid source time stays unknown. Fetch time must not substitute for when a message was sent. |
| `headers`, `thread_references` | Subject, participants, original Message-ID, In-Reply-To, and References; retain provider-specific thread IDs separately if supplied. |
| `payload_format`, `payload_locator`, `payload_sha256` | Exact fetched payload representation and checksum. For iCloud full-message fetch, retain original MIME bytes before decoding. Never claim structural reserialization is byte preservation. |
| `normalization_version`, `coverage` | Decoder version, fetched byte/part ranges, deferred attachments, and explicit complete/partial/error status. |
| `raw_path`, `source_revision`, `promotion_receipt` | Only after deliberate vault promotion: exact source path and SHA256 of that actual vault source, distinct from the original MIME checksum. |

IMAP `INTERNALDATE` and the message's Date header have different meanings; preserve both. [RFC 9051, internal date](https://www.rfc-editor.org/rfc/rfc9051.html) Message-ID is optional, and reply-reference fields describe relationships. Use them as candidate thread edges, not the sole cross-account deduplication key; keep both records unless a verified projection relationship permits deduplication. [RFC 5322, identification fields](https://www.rfc-editor.org/rfc/rfc5322.html)

Email normalization must handle MIME/charset decoding, prefer available plain text, sanitize HTML, and defer remote images and attachments by default. Mail content is untrusted evidence, including quoted instructions, rather than executable agent instructions. Short messages can be valuable typed records; a long-document admission threshold must not silently discard them. These are proposed requirements needing synthetic MIME fixtures.

For the 8 GB desktop, start with one synchronization/promotion job at a time, metadata-first admission, streamed payload storage, bounded model context, and deferred attachment extraction. A proposed initial automatic body budget is 1 MiB per message; exceeding it records partial/deferred coverage and offers an explicit full-fetch path. A truncated body cannot receive a full-message read/completion receipt. Existing source-revision/citation validation can be reused after adapter integration; that integration is not implemented by this contract.

## iPhone scheduling, retention, and disconnect

iOS schedules background refresh at its discretion; background refresh is not a continuously available execution slot. Therefore start with foreground/reconnect synchronization and an opt-in desktop worker while awake. Do not promise a persistent iPhone IMAP IDLE socket. A hosted worker adds credential custody and deployment obligations and needs a separate explicit design. [Apple background strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app)

Proposed disconnect stops jobs/connections and deletes this app's Keychain credential and reconnect state. Explain Apple-side revocation separately: revoke an app-specific password, or remove supported authorization under Account Data Sharing. Authentication failure becomes `reauthorization_required`; it never means the mailbox is empty. Show last successful sync, selected folders, counts, partial coverage, retry, and credential recovery.

Use a managed encrypted external-source cache with a stated retention limit before immutable promotion. Remote deletion, disconnect, and a request to erase app-held data are separate operations. Erasure must include the defined connector cache, derived indexes, and source-dependent artifacts; existing vault `raw/` remains immutable unless an explicitly approved erasure design changes that invariant. Do not enable an unlimited mailbox-to-raw archive before resolving this boundary.

Google Workspace rules remain relevant to Gmail-source records; do not automatically relabel them as Apple's iCloud rules. Reviewed Apple access documents do not grant blanket permission for permanent archival, redistribution, or external model training. Applicable Apple terms, content rights, user consent, and model-provider retention terms still require review for the chosen product. [Apple iCloud terms](https://www.apple.com/legal/internet-services/icloud/en/terms.html)

Local embeddings and local retrieval are the proposed default. Any cloud inference, CLI agent, subprocess, or hosted sync must expose the actual destination and transmit only the user-approved purpose/coverage. A CLI invocation is not proof of local inference. Credential encryption does not itself authorize content transmission.

## Acceptance checks before live use

Use synthetic protocol/MIME fixtures for UID gaps, reused UIDs after UID validity reset, identical Message-IDs across accounts/folders, folder moves, `\Deleted` versus expunged messages, extension negotiation, `NOMODSEQ`, delayed `VANISHED`, large MODSEQ values, and reconnect without extensions. Test partial literals, expunge during fetch, interrupted UID search, crashes before checkpoint publish, idempotent replays, and competing writers. Confirm no source read changes `\Seen`, no write/SMTP commands occur, and no secret/body enters logs.

Verify missing/offset-bearing message timestamps, multipart/HTML-only messages, deferred attachments, over-budget bodies, explicit partial coverage, source-revision receipts, deleted-record retrieval, disconnect, and revoked credentials. Native Keychain/background behavior requires an actual iPhone/Xcode validation step; no such test was run here.

Next concrete milestone: a tested read-only IMAP adapter with a user-created app-specific password, one selected mailbox, encrypted credential storage, capability capture, and baseline staged reconciliation. Only then add negotiated extensions and shared email promotion. The reviewed Apple support pages are dated 2026-02-03 (server settings), 2025-10-08 (app-specific passwords), and 2025-10-07 (supported authorization); recheck them when implementing live access. No personal mailbox, account, model, or server was accessed for this document.
