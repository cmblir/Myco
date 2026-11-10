# Google Calendar and Gmail sync contract

Reviewed: 2026-10-04. Status: implementation design; no live account authorization or connector implemented.

The existing `google-api` provider is Gemini inference through `generativelanguage.googleapis.com` (`src-tauri/src/providers.rs`, `src/lib/providers.ts`). It does not grant Calendar or Gmail access. This document specifies the next connector boundary; it is not a claim that account sync, background delivery, token storage, or an iPhone native build already works.

The selected email targets are both Gmail and iCloud Mail. Keep their adapters
and authorization separate while sharing the typed email evidence boundary in
the [iCloud Mail contract](2026-10-04-icloud-mail-contract.md). Gmail message IDs
and label memberships must not be replaced by IMAP mailbox/UID identity.

## Read-only account access, iPhone first

Create separate registered Google OAuth clients for iOS and desktop. Use the authorization-code installed-app flow, fresh random `state`, PKCE `S256`, an exact registered redirect, and the system authentication browser. Do not embed a confidential client secret in the app. Mobile loopback redirects are deprecated; choose the documented iOS redirect. Google's installed-app guide says incremental authorization is unsupported: feature selection must initiate a supported authorization request, rather than assuming web-only incremental-auth behavior. [Google native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

For iPhone, the proposed native boundary is `ASWebAuthenticationSession` for interactive authorization and Keychain for access/refresh credentials. OAuth credentials never belong in Markdown, `localStorage`, a vault, Git, logs, or LLM input. Native Xcode/device validation is still required; this host does not have Xcode. [Apple authentication session](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession), [Apple Keychain](https://developer.apple.com/documentation/security/keychain-services)

| Proposed feature to authorize | Scope proposal | Boundary |
| --- | --- | --- |
| Read event details | `https://www.googleapis.com/auth/calendar.events.readonly` | No event edits or invitations |
| Select subscribed calendars | `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | Needed only when providing that selection UI |
| Read email bodies | `https://www.googleapis.com/auth/gmail.readonly` | Restricted scope; no sending, label edits, or mailbox deletion |
| Header/label-only email feature | `https://www.googleapis.com/auth/gmail.metadata` | Also restricted; does not provide message bodies |

These scopes come from the [Calendar scope reference](https://developers.google.com/workspace/calendar/api/auth) and [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes). Do not request `calendar`, `gmail.modify`, or `https://mail.google.com/` for a read-only wiki. Account identity and feature scopes must remain separate. A sign-in alone does not authorize either data source.

External OAuth projects in `Testing` generally receive seven-day refresh tokens for these data scopes; the profile-only exception does not cover Calendar/Gmail. Treat `invalid_grant` as a reconnect state, not an empty successful sync. Verification exemptions can cover personal use or development/testing; they do not establish exemption from every data-use obligation. Public distribution needs its own scope verification review. Restricted data stored on or transmitted through servers can trigger a security assessment. [Token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [Verification exceptions](https://support.google.com/cloud/answer/13464323), [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)

## Calendar protocol

Verified API behavior:

1. Fetch the selected calendar's initial event collection, following every `nextPageToken`; `nextSyncToken` arrives on the final page.
2. Incremental requests use the stored `syncToken`, and paginate with that same token and consistent query parameters. They include deleted records.
3. `410 Gone` means the token is invalid: rebuild the managed synchronized view with a full sync. This is not permission to delete the user's immutable vault originals.

Source: [Calendar incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync).

`syncToken` cannot be combined with `timeMin`, `timeMax`, `q`, `orderBy`, `updatedMin`, and several other filters. Keep the remote synchronization contract stable, then filter the local view for the user's date range. [Events list reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)

Preserve original all-day `date` values, offset-bearing `dateTime`, `timeZone`, recurrence rules, `recurringEventId`, and `originalStartTime`. A cancelled recurring exception suppresses one occurrence; it is not deletion of its parent series. Event identity is scoped to the calendar, and `iCalUID` differs from event `id`. [Event resource reference](https://developers.google.com/workspace/calendar/api/v3/reference/events)

Webhook channels expire and require explicit replacement. Notifications identify a changed collection, without the changed event body; they trigger another sync request. An always-available HTTPS endpoint is a separate deployment choice, not a capability of a sleeping desktop or background iPhone app. The first implementation can synchronize on foreground/reconnect before adding hosted notifications. [Calendar push guide](https://developers.google.com/workspace/calendar/api/guides/push)

## Gmail protocol

Verified API behavior:

1. Initial sync lists message IDs with pagination, then retrieves the necessary messages with `messages.get`; listing IDs is not downloading bodies.
2. Save a valid recent `historyId` for subsequent `history.list(startHistoryId=...)` requests. Fetch all pages and reconcile the added/deleted-message and label changes idempotently.
3. History retention is not guaranteed indefinitely. An expired/out-of-range history cursor returns `404`; perform a fresh full reconciliation.

Source: [Gmail synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync), [History list reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

Gmail `watch` uses Cloud Pub/Sub, with an expiration in the response. Renew at least every seven days; Google recommends daily renewal. A notification supplies mailbox/history information, not the email body. Push remains a hint to run the cursor protocol; it cannot replace periodic recovery. [Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push)

## Proposed local state and commit boundary

The following are design decisions, not existing connector behavior:

- Stable remote identity: `{provider, authorized_account_id, collection_id, remote_record_id}`. Subject lines, calendar titles, email addresses, filenames, and import dates are display data, not identity. Keep message identity separate from Gmail thread identity.
- Preserve provider revision/ETag, provider event/message time, fetched time, original typed payload, normalized text, provenance, and deletion state separately. A SHA256 identifies exact payload bytes, not claim correctness or user intent.
- Stage all fetched pages and required payload retrievals. Publish an idempotent source batch and its resumable promotion queue before advancing the sync checkpoint. A failed page, offline transition, parsing failure, or permission error must not advance the cursor or silently replace the complete view with a partial one.
- Keep remote ingestion separate from wiki promotion. A source batch can be durable while a wiki draft remains pending. Publish derived pages only after actual source coverage, exact quotes/citations, conflict checks, and current source-revision validation.
- A remote deletion appends a tombstone and removes the record from the active search view. Mark dependent wiki claims stale or withdrawn and invalidate lexical/dense caches. A full resync rebuilds the managed active view; it does not rewrite old evidence as though it were current.
- Store cursors per account/collection and synchronization configuration. Changing the selected calendars, scope, or remote filter invalidates the corresponding checkpoint; another account must never inherit it.
- Expose `idle`, `connecting`, `syncing`, `partial/error`, `reauthorization_required`, and `up_to_date`, along with last successful checkpoint, selected collection, record counts, and retry. A webhook delivery or token refresh is not proof of a completed data sync.

Do not wire a connector directly into `raw/` as an unlimited permanent mailbox dump. A managed encrypted external-source cache needs a retention/deletion contract before durable promotion. Existing vault `raw/` is immutable, including manual writes; account disconnect, provider deletion, and a request to erase app-held data are distinct operations. Required erasure must be resolved through an explicitly approved design rather than silently overriding that invariant.

## Retention and cloud-model boundary

The Workspace policy applies to access through Gmail/Workspace developer interfaces, not merely Marketplace publication. It recognizes automatic email backup and user-facing productivity features including AI summaries, while excluding one-time/manual email-export applications. General Terms restrict permanent copies/cache retention **unless the content owner or law expressly permits them**. Therefore neither “all personal local archives are forbidden” nor “personal OAuth permits an unlimited archive” follows automatically. Determine the approved use, content rights, response cache requirements, and deletion contract before release. [Workspace policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), [API Terms, section 5](https://developers.google.com/terms#section_5_content)

Limited Use covers derived information as well as source data. Transfer to an external inference provider requires a visible user-facing purpose and consent; generic model training beyond that user's personalized permitted feature is prohibited. Providers, CLI agents, operators, and subprocesses must respect the same boundary. “CLI” is not proof of local inference. Local embeddings are preferable for indexing; cloud transmission requires its own user-visible control and compliant provider retention/training terms. Token encryption, secure transport, and user-data protection remain necessary. [User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), [Workspace Limited Use and security](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#limited_use_of_user_data)

Policy interpretation is an implementation constraint to confirm for the chosen product, not a claim of Google approval. The reviewed Workspace policy was updated 2026-09-03; Gmail scopes 2026-09-10; Calendar sync 2026-09-11; general OAuth token guidance 2026-05-26. Recheck these primary sources when enabling live account access.

## Required acceptance checks before live use

Use synthetic responses to test multi-page commit/retry, crash recovery, identical replays, changed revisions under one ID, multiple accounts with colliding remote IDs, deletion/recurrence exceptions, timezone/all-day events, `410`/`404` recovery, expired authorization, and declined scopes. Check that stale/deleted revisions never answer current-state questions. Verify that source text and credentials never enter logs and that no cloud model receives restricted content without the configured disclosure/consent and provider policy.

Next concrete milestone: registered iOS/desktop OAuth clients, one read-only Calendar account, encrypted token persistence, staged paginated sync, and active-view deletion tests. Gmail remains a separate feature with its restricted-scope and retention review. No OAuth client credentials, personal data, live account calls, or new model dependencies were added for this document.
