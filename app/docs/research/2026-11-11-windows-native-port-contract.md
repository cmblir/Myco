# Windows native identity and publication port contract

Inspected revision: `4b582924`. Date: 2026-11-11.
Status: implementation and Windows execution remain incomplete.

Follow-up at `2b26f802`: hosted Windows execution is now available through
[draft PR #31](https://github.com/cmblir/Myco/pull/31). The existing CI's
[Windows job](https://github.com/cmblir/Myco/actions/runs/42938959505/job/130255882564)
completed with 2,132 passed, 247 failed and 31 ignored. See the
[current inventory](2026-11-11-windows-current-failure-inventory.json).
This is a failing default test run, not installed-app acceptance. The original
availability observations below describe the earlier audit.

## Revalidated execution availability

- `rustup target list --installed` returned only `aarch64-apple-darwin`.
- `wine`, `prlctl` and `qemu-system-x86_64` were not found on PATH.
- The read-only GitHub API request for `repos/cmblir/Myco/actions/runners`
  returned `total_count: 0` and an empty runner list. This says nothing about
  GitHub-hosted Windows availability; no workflow was dispatched and no branch
  was pushed.
- The owner subsequently confirmed that no Windows PC/VM is available.
  Native execution therefore requires a hosted Windows runner or another
  newly available environment; no current Windows pass is claimed.

The [baseline failure inventory](2026-11-11-windows-failure-inventory.json)
remains historical evidence, not a test result for the current revision. Its
90 unresolved assertion/other cases still need first-cause investigation.
Eleven temporal-recall assertions were reclassified by inspecting the baseline
native-path conversion, slash-only source filter and recorded zero/incomplete
results. The current portable-key repair is not a Windows runtime pass.

## Current dependency chain

| Boundary | Current implementation | Windows work that must precede enabling callers |
| --- | --- | --- |
| Live receipt identity | `vault.rs::RecordedFileIdentity` stores Unix device/inode/change time; `recorded_identity` returns `None` outside Unix. Retained handles are Unix-only. | Retain a live Windows handle and compare full native object identity; keep byte revisions separate from object identity. |
| Confined private directory | `vault_compiler_pin.rs::CompilerPinDirectory::verify`, `open_compiler_pin_directory` | Bind the private directory and ancestors without following replacement reparse targets. Test directory replacement and access denial. |
| Restart custody | `capture_compiler_initial_file_pin_locked`, `reopen_compiler_prior_file_pin`, `compiled_custody.rs::Store` | Reopen the privately recorded anchor and baseline, verify their current identities, and recover only update permission. Never recreate completion authority from serialized fields. |
| Publication | `distill_publication.rs::publish_locked` rejects non-Unix execution. | Prove creation/revision CAS and exact persisted-handle observation before returning a native receipt. Preserve partial writes and recovery records on every failure seam. |
| Source grants | `inbox_source.rs::verify_identity` and `audio_overview/sources.rs` reject non-Unix identity checks. | Reject same-byte replacement, unexpected hard links and reparse targets; keep the original source on cancellation or failure. |
| Maps and retirement | `map_custody.rs`, `vault_compiler_retirement.rs` rely on the same physical pins. | Port only after the shared physical primitive is proven. Keep section ownership, source snapshots, mutation guards and opening tokens intact. |

## Identity and sharing decisions to verify on Windows

Windows `FILE_ID_INFO` combines a volume serial number with a 128-bit file ID.
Comparing both identifies the file represented by two open handles. The existing
single `u64` inode field cannot carry that full ID without a representation
change; truncating it is not an acceptable port. Use a versioned platform-tagged
identity representation and preserve compatibility with existing Unix records.
[Microsoft FILE_ID_INFO documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)

API availability must be checked on the actual filesystem. Microsoft's handle
comparison guidance describes a 64-bit fallback when 128-bit IDs are unsupported,
with invalid sentinel IDs rejected. Such a fallback needs an explicit format tag
and tests; it must not silently equate differently represented identities.
[Microsoft handle identity guidance](https://devblogs.microsoft.com/oldnewthing/20220128-00/?p=106201)

Opening a final reparse point with `FILE_FLAG_OPEN_REPARSE_POINT` does not by
itself establish this app's complete ancestor-confinement invariant. Separately,
delete sharing affects whether other handles may rename/delete an object.
Choose and test sharing/access flags together with the replacement algorithm;
neither allowing all sharing nor denying all sharing establishes publication
correctness by itself. This is an implementation requirement derived from the
app's retained-handle invariants, not an already-verified Windows solution.
[Microsoft reparse-point guidance](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations),
[Microsoft CreateFile sharing documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)

## Ordered implementation and acceptance

1. Run an isolated Windows primitive test with native handles before changing
   production gates. Record filesystem type and permissions. Verify same object
   through two handles, same-byte path replacement, in-place edits, added hard
   links, directory replacement, junction/symlink targets, denial, Unicode and
   spaces. Reopen after process exit and distinguish unsupported operations from
   ordinary absence. A denied operation must retain source and draft.
2. Implement the shared physical identity/directory/pin layer and versioned
   record decoding. Keep Unix behavior unchanged. Old or unknown Windows record
   formats must not acquire authority by default.
3. Integrate source grants, creation CAS, refresh custody, map snapshots and
   retirement in that order. Exercise interruption before persistence, after
   bytes persist, after journal/head persistence, and during cleanup. A successful
   rename alone is not evidence that the complete restart contract is durable.
4. Re-run existing `vault_publication_identity_tests`, `vault_compiler_pin_tests`,
   `inbox_source_tests`, publication/custody/recovery suites and the full Windows
   suite. Preserve failing assertions; do not turn them into platform skips.
5. Run the synthetic native capture → publish → Ask → normal quit/restart flow
   on Windows, including human edits during refresh. Re-run macOS/Linux shared
   tests. Cross-compilation, primitive tests, or a green macOS suite alone do not
   close G3.

No production guard, dependency, supported-platform claim or native receipt
format was changed in this audit. No Windows build or runtime pass is claimed.

## Isolated native handle tests prepared after the hosted run

`windows_identity_tests.rs` adds four Windows-only tests before production
integration. They compare the full volume/128-bit pair from `FILE_ID_INFO`,
distinguish same-byte replacement from in-place edits, reopen a retained path,
observe hard-link count changes, retain directory identity across replacement,
and verify sharing-denied writes/deletion preserve source bytes. The diagnostic
prints the actual filesystem name. These tests do not establish process-restart
custody, reparse/ancestor confinement, ACL behavior or durable publication.

The exact already-locked Microsoft `windows-sys` 0.61.2 bindings are connected
only as a Windows dev-dependency. Their source archive checksum was verified
against Cargo.lock before inspecting the API declarations. Normal certificate
verification remains enabled; Python's TLS request failed, while system curl
retrieved the archive successfully. No version was upgraded.

The CI diagnostic step runs the filtered tests with output visible, then always
continues to the unchanged full Windows suite, which includes and gates the same
tests. Native compile and execution results remain pending. The added tests grant
no production authority and do not change any non-Unix rejection gate.
