# Memex → myco rebrand — design

The product is renamed from **Memex** to **myco** (the name its mascot already
carries). Decision: rename *everything*, including internal identifiers, and
migrate every piece of persisted state so existing installs keep working.

This is not a find-and-replace. ~1085 occurrences across ~168 files fall into
five very different risk classes, and eight of them carry user data.

## Ground truth (surveyed 2026-07-28)

- Nothing reads the product name at runtime — there is no `CARGO_PKG_NAME` or
  `productName` lookup anywhere. Every occurrence is a hardcoded literal, so
  there is no single switch to flip.
- `settings_dir()` is implemented **twice**: `app/src-tauri/src/settings.rs:141`
  and a hand-copied Python mirror at `mcp-server/project_registry.py:33`. If they
  disagree the MCP server silently stops following the app's vault.
- The three desktop platforms use three different naming conventions today:
  macOS `dev.cmblir.memex`, Windows `%APPDATA%\Memex`, Linux `~/.config/memex`.

## Migrations (the whole point of this document)

Each runs **once**, is idempotent, and must leave the old state untouched if the
new state already exists.

**M1 — app-data directory.** `dev.cmblir.memex` → `dev.cmblir.myco` (macOS),
`Memex` → `myco` (Windows), `memex` → `myco` (Linux). Contains `settings.json`,
the `active-vault` marker, `mcp-token`, and `embeddings/` (`.mxv`/`.mxb`). Move
on first launch when the old dir exists and the new one does not; on any failure,
keep using the old path rather than starting empty. The Python mirror must apply
the same rule, and both must honour `MYCO_DATA_DIR` (with `MEMEX_DATA_DIR` still
accepted).

**M2 — OS keychain.** Service `dev.cmblir.memex` → `dev.cmblir.myco`
(`src/secrets.rs:7`). The keychain cannot be enumerated by service here, so the
migration walks the *known* account names (provider keys, `memex-pro`) and
re-writes each under the new service, deleting the old entry only after a
verified read-back. A missed entry means a user silently loses an API key.

**M3 — launchd labels.** `dev.cmblir.memex.digest.{id}` → `dev.cmblir.myco.…`
(`src/schedules.rs:133`). **Renaming alone is not enough**: already-installed
LaunchAgents keep firing under the old label forever. The migration must
`launchctl bootout` (or `unload`) each old agent and delete its plist *before*
installing the new one, and must be safe when the old plist is absent.

**M4 — localStorage keys (9).** `memex.errorlog`, `memex.onboarded`,
`memex.lastVaultPath`, `memex.graph.settings.v26`, `memex.graph.savedLooks.v1`,
`memex.graph.clusterTopics.v1`, `memex.linkSuggestions.dismissed.v1`,
`memex.budget.usage.v1`, `memex.budget.threshold.v1`, plus the zustand persist
name `memex-ui`. Read-old-if-new-absent, write under the new key, then remove the
old. Getting this wrong re-shows onboarding and loses saved graph looks.

**M5 — persisted serde fields.** `memex_pro_url`, `memex_pro_email`, `memex_pro`
(`src/settings.rs`) and their TypeScript mirrors. Rename the fields but keep
`#[serde(alias = "memex_pro_…")]` so an existing `settings.json` still parses.
Separately, `ingest_provider` may hold the *value* `"memex-pro"` — map it on read.

**M6 — MCP registration.** The server is registered in the user's `~/.claude.json`
as `memex` (`src/mcp_native.rs:106,115,156,165`). The connect flow must remove the
**old** `memex` registration before adding `myco`, or the user ends up with a
stale duplicate pointing at the same port. The Python module
`mcp-server/memex_mcp.py` is renamed, and its stale `__pycache__` removed.

**M7 — deep-link scheme.** `memx://` (`tauri.conf.json:60`, `src/clip.rs:37`,
`clipper/`). Register the new scheme **and keep `memx://` registered and parsed**:
bookmarklets users already saved are frozen at the old scheme and cannot be
updated by us. This is permanent backwards compatibility, not a migration.

**M8 — per-vault `.memex/` dotdir.** Holds `schedules.json`, `ledger.json`,
`cache.db`, digest logs (`src/schedules.rs:75`, `src/importers/ledger.rs:68`,
`automation/digest.py:54`). Rename to `.myco/` and migrate per vault on open; the
ignored-dotdir list (`src/vault.rs:676`) and the vault `.gitignore` must move with
it. This one lives inside the user's own vault, so a botched move is visible.

**Env vars.** ~30 `MEMEX_*` names are documented for users. Rename to `MYCO_*`
and accept the `MEMEX_*` spelling as a fallback.

## Deliberately NOT renamed

- `.mxv` / `.mxb` index extensions and their `MXV1` / `MXB1` magic bytes — they
  are `mx*`, never spelled "memex", and rewriting the format would invalidate
  every index for no benefit.
- **Vannevar Bush's memex** — `README.md:50,487`, `README-ko.md:50,461`, including
  the `en.wikipedia.org/wiki/Memex` link. This is the historical concept the
  product was named *after*; replacing it corrupts the sentence and breaks a URL.
- `projects/karpathy-llm/wiki/memex.md` and the vault pages citing it — that is
  dogfood *content* with a wikilink graph and citation anchors, not source.
- Third-party-adjacent keys such as the three.js shader cache key
  `memex-edge-flow` may be renamed but must stay globally unique.

## Copy that needs rewriting, not replacing

Several strings read "MYCO, the Memex mascot" (`README.md:164`,
`app/CHANGELOG.md:336`, `MascotClip.tsx:1`). A literal replace yields "MYCO, the
myco mascot". These need human-sensible rewording: the mascot's name became the
product's name, so the sentence should say so.

## Also in scope

- **GitHub repo** `cmblir/Memex` → `cmblir/myco`, with description and topics
  updated, and every hardcoded `cmblir/Memex` URL in the READMEs fixed. Local
  remotes must be re-pointed.
- **Version display bug** — `PageSettings.tsx:1668` hardcodes
  `v0.2.2 · build 2026.07.15` and has never been bumped; the current version is
  already 0.3.0. Source it at runtime (`@tauri-apps/api`'s `getVersion()` is
  already a dependency and unused) instead of re-hardcoding it.
- **Artifact names** in docs (`Memex_x.y.z_universal.dmg` etc.) follow
  `productName`, so they change automatically — the docs quoting them must follow.

## Verification

Unit tests cannot prove a migration works; they prove the code compiles against a
fixture. Each of M1-M8 must be exercised against **real pre-existing state on the
device**: install/run the old build, produce real settings, keys, schedules, graph
looks and a vault, then run the new build and confirm every one survived — and
that running it twice does not double-migrate. Anything not driven that way is
reported as unverified ([[verify-renders-at-scale]]).

## Sequencing

1. Migrations + rename, behind no flag but landed in reviewable stages (M1/M2/M3
   are independent; M4/M5 are frontend+settings; M6/M7/M8 touch external
   contracts).
2. Real-device verification of the upgrade path.
3. Code signing wired into `release.yml` (secrets already registered).
4. Tag `v0.3.0` as the first myco release.

Rationale for that order: signing is switched on last because an empty/missing
signing secret makes `tauri-action` fail the whole macOS bundle, and we do not
want that failure mixed into the rebrand's first release.
