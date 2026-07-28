# myco rebrand — execution plan (Stages B → G)

**This file is self-contained. Read only this and drive the work to the end.**
Companion (optional, deeper rationale): `docs/2026-07-28-myco-rebrand-design.md`.

Goal: finish renaming the product **Memex → myco** (the name its mascot already
carries), migrate every piece of persisted state so existing installs survive,
turn on Apple code signing, and ship **v0.3.0 as the first myco release**.

---

## 0. Where things stand

**Repo:** `/Users/yoo/project/Memex`. Rust crate `app/src-tauri`, frontend `app/`,
Python MCP server `mcp-server/`.

**Git: 9 commits committed LOCALLY, NOT PUSHED.** `origin/main` = `c902144`,
local HEAD = `cbd8db6`. Oldest → newest:

| commit | what |
|---|---|
| `17c49ae` | `chore(release): v0.3.0` — CHANGELOG + version bump. **Written before the rebrand; must be redone/reordered so it is the last commit before the tag.** |
| `242f33f` | rebrand design doc |
| `f96ee12` `aa385ac` `972299d` | Stage A: M1 app-data dir, M2 keychain, M3 launchd |
| `043984a` `ac5f1fe` `b0f0175` `cbd8db6` | Stage A blocking fixes |

Deliberately unpushed: main would otherwise carry a half-rebrand (data paths
already myco while the product is still called Memex). This is safe — releases
here are **tag-triggered**, not push-triggered. Push at a coherent point, after
Stage D.

**Stage A is DONE and re-reviewed by execution.** App-data directory (3 platforms,
Rust + the hand-copied Python mirror), OS keychain service, and launchd digest
labels all migrate. `cargo test` 364 pass, Python 40 pass.

**Environment, both real:**
- `cargo clean` was run. **The next build is a cold rebuild including llama.cpp
  C++ — budget tens of minutes.** Disk is fine now (38 GB free).
- **`main`'s CI has been red for weeks**, from before this work: repo-wide
  `cargo fmt` drift, plus two Windows-only test failures that are platform path
  assumptions (`vault.rs:1888` expects `wiki/alpha.md`, `whisper.rs:163` expects
  `/tmp/x/talk`; Windows produces backslashes). The user chose to ship anyway and
  fix CI separately. Do not let a red CI stop the release, and do not silently
  "fix" it by running `cargo fmt` across the repo inside a rebrand commit.

---

## 1. Non-negotiables

**Never rename these.** Each has a concrete reason:

- `.mxv` / `.mxb` index extensions and their `MXV1` / `MXB1` magic bytes
  (`vector_index.rs:32`, `retrieval.rs:22`) — they are `mx*`, never spelled
  "memex"; rewriting them invalidates every user's index for nothing.
- **Vannevar Bush's memex** — `README.md:50,487`, `README-ko.md:50,461`,
  including the `en.wikipedia.org/wiki/Memex` link. The product was *named after*
  it; replacing the word corrupts the sentence and breaks a URL.
- `projects/karpathy-llm/wiki/memex.md` and the vault pages citing it
  (`wiki/index.md`, `wiki/log.md`, `wiki/source-getting-started.md`,
  `raw/getting-started.md`) — that is dogfood **content** with a wikilink graph
  and citation anchors, not source. `.gitignore:50` un-ignores it on purpose.
- `memx://` — the deep-link scheme. **Keep it registered and parsed forever.**
  Bookmarklets users already saved cannot be updated by us.

**The trap that already bit us once.** A plain `cargo test` renamed the
developer's real `~/Library/Application Support/dev.cmblir.memex`, making their
installed app look factory-reset (restored by hand; nothing lost). Cause:
`retrieval.rs:371` → `settings_dir()` → the migration. Stage A now refuses the
real path from test binaries (`cfg!(test)` plus an arg0-under-`deps/` check),
with opt-in via `test_support::with_isolated_data`.
**For every remaining stage: before and after any test run, check that
`~/Library/Application Support/dev.cmblir.memex` still exists and
`dev.cmblir.myco` does not** (until the identifier actually flips in Stage D).
Tell the reviewer to hunt for test paths that reach real user state.

**Migrations are never proven by unit tests.** They are proven by running an old
build, producing real state, then running the new one. Section 6 is that
checklist; anything not driven there is reported as unverified.

---

## 2. Stage B — localStorage keys + persisted serde fields

### B1. localStorage (10 keys)

Read-old-if-new-absent → write under the new key → remove the old. Do it once, at
startup, before any consumer reads. Getting it wrong re-shows onboarding and
loses saved graph looks.

| key | file:line |
|---|---|
| `memex.errorlog` | `app/src/main.tsx:7` |
| `memex.onboarded` | `app/src/App.tsx:41` |
| `memex.lastVaultPath` | `app/src/stores/vaultStore.ts:9` |
| `memex.graph.settings.v26` | `app/src/lib/graphSettings.ts:196` |
| `memex.graph.savedLooks.v1` | `app/src/lib/graphSettings.ts:529` |
| `memex.graph.clusterTopics.v1` | `app/src/lib/clusterTopics.ts:14` |
| `memex.linkSuggestions.dismissed.v1` | `app/src/lib/linkSuggestions.ts:71` |
| `memex.budget.usage.v1` | `app/src/lib/budget.ts:46` |
| `memex.budget.threshold.v1` | `app/src/lib/budget.ts:48` |
| zustand persist name `memex-ui` | `app/src/stores/uiStore.ts:109` (has `version: 3` — do not reset it) |

### B2. Persisted serde fields

Rust `app/src-tauri/src/settings.rs`: `memex_pro_url` `:24`, `memex_pro_email`
`:28`, `memex_pro` `:90` (in `ProviderFlags`), defaults `:57,:58,:107`.
Rename the fields **and keep `#[serde(alias = "memex_pro_…")]`** so an existing
`settings.json` still parses.

TS mirrors: `app/src/lib/ipc.ts:229,238,240`. Consumers:
`PageSettings.tsx:740,742,743,762`; `providers.ts:119,120,140`;
`devMock.ts:596,601,602,822,823,837,838`; `commands.rs:1059,1077,1088,1089`.

**Separately: `ingest_provider` may hold the stored *value* `"memex-pro"`**
(`app/src/stores/ingestStore.ts:293`, `providers.ts:119`). Map it on read — a
renamed id with no mapping silently deselects the user's ingest provider.

Keychain account name `"memex-pro"` (`commands.rs:1063,1083,1101`) is already
handled by Stage A's migration list — if you rename the id, the migration list
must move with it.

---

## 3. Stage C — external contracts

### C1. MCP registration name

Registered in the user's `~/.claude.json` as `memex`:
`mcp_native.rs:106` (printed command), `:115` (JSON snippet), **`:156`
(`mcp remove memex`)**, `:165` (the `add` arg), `:179` (status string).
Rust types `MemexServer` `:539,540,684,1648,1657`; tool descriptions
`:693,:720,:1209`.

**The connect flow must remove the OLD `memex` registration before adding
`myco`**, or the user ends up with a stale duplicate pointing at the same port.

Python side: module file `mcp-server/memex_mcp.py` (imported as
`from memex_mcp import …` in `mcp-server/test_memex_mcp.py:7`), prog name
`:1305`, registration `:1292,:1296`, error prefix `:1281`. Install/serve scripts:
`mcp-server/install.sh:24,34,38,50,56,65`, `serve.sh:12,21,32`, `README.md:94`.
Delete the stale `mcp-server/__pycache__/memex_mcp.cpython-314.pyc`.
Port 22360 is not name-derived — leave it.

### C2. Deep link

Register the new scheme **in addition to** `memx://`, and accept both in the
parser: `tauri.conf.json:60` (`"schemes": ["memx"]`), `clip.rs:37` (parser),
`lib.rs:211` (handler), `clipper/background.js:13`, `clipper/README.md:7,14,25,33`
(the bookmarklet). Also `clipper/manifest.json:3,5,8` (extension name/description
/title — cosmetic, but an already-installed unpacked extension keeps its old ID).

Note `memex://clip-saved` is a **Tauri event name**, not a URL scheme — emit
`lib.rs:248`, listen `App.tsx:224`, mock `devMock.ts:1211,1218`. Both sides must
change together or the clip toast stops firing.

### C3. Per-vault `.memex/` directory

Lives **inside the user's vault**, so a botched move is visible. Holds
`schedules.json`, `ledger.json`, `cache.db`, digest logs.
`schedules.rs:75,93,236`; `importers/ledger.rs:68,128`; the ignored-dotdir list
`vault.rs:676`; `automation/digest.py:54`; `.gitignore:27`; smoke scripts
`app/scripts/smoke.sh:98,99`, `smoke_full.sh:60,95,96`.
Migrate per vault on open, and move the ignored-dotdir entry and the generated
vault `.gitignore` with it.

### C4. Environment variables

~30 `MEMEX_*` names, documented for users. Rename to `MYCO_*` **and accept the
`MEMEX_*` spelling as a fallback**: `MEMEX_DATA_DIR`, `MEMEX_PROJECT_ROOT`,
`MEMEX_CLAUDE_PATH`, `MEMEX_CLAUDE_TOOLS`, `MEMEX_GEMINI_PATH`,
`MEMEX_CODEX_PATH`, `MEMEX_WHISPER_PATH`, `MEMEX_WHISPER_CLI_PATH`, `MEMEX_PERF`
(+ the `[memex-perf]` log prefix), `MEMEX_MCP_TOKEN/_TRANSPORT/_HOST/_PORT`,
`MEMEX_EMBED_SPEC`, `MEMEX_RERANK_MODEL`, `MEMEX_WIKIFY_DUMP`, and the
`MEMEX_{ANTHROPIC,OPENAI,OPENROUTER,GOOGLE,OLLAMA}_URL` set used by
`tests/provider_adapters.rs`. `MYCO_DATA_DIR` already exists from Stage A —
follow that pattern.

---

## 4. Stage D — the visible rename

Now flip everything a human sees, **including the bundle identifier**.

- `tauri.conf.json`: `productName` `:3`, **`identifier` `:5`
  (`dev.cmblir.memex` → `dev.cmblir.myco`)**, window `title` `:17`,
  `longDescription` `:53`.
- `Cargo.toml`: package `name` `:2`, description/authors `:4,5`, **`[lib] name`
  `:10` `memex_lib`** — that last one forces **24 `memex_lib::` imports across 14
  files** to change (`src/main.rs`; tests `vault_lifecycle.rs:6-9`,
  `provider_adapters.rs:5`, `native_bridges.rs:18,19`, `git_log_real.rs:5`;
  examples `bench_local_llm.rs:26`, `wikify_eval.rs:35`, `test_claude_ipc.rs:5`,
  `retrieval_eval.rs:29,37,259`, `mcp_spike.rs:5`, `test_ingest.rs:5,21`,
  `test_local_llm.rs:9,16`; `benches/vector_store.rs:23,24`).
- `app/package.json:2,3`, `app/package-lock.json:2,8`, `Cargo.lock` package entry.
- `.github/workflows/release.yml:71,73` (`releaseName`, body prose).
- `app/index.html:6` `<title>`.
- i18n `app/src/lib/i18n.ts` — 89 hits, incl. `app_name` `:755`,
  `eb_reload` `:1176`. Keys `s_memexpro_*` `:477-484` and
  `s_provider_desc_memex_pro` `:750` are internal key names; rename with their
  consumers or leave — just be consistent.
- Rust user-facing strings: `local_llm.rs:536` (the assistant's system prompt
  says "You are Memex's built-in assistant"), `lib.rs:242` ("Clipped to Memex").
- CSS classes `memex-modal/editor/viewer/menu/wikilink`: `app/src/styles.css`
  (16) + `DialogHost.tsx:104-135`, `OnboardingWizard.tsx:92,97`, `Viewer.tsx:46`,
  `Editor.tsx:91`, `Sidebar.tsx:442,459,468`, `lib/markdown.ts:41,62` — must move
  in lockstep with the stylesheet.
- Docs: `README.md` (44), `README-ko.md` (40), `app/README.md` (24),
  `app/CHANGELOG.md` (23), `docs/**`, `CLAUDE.md`, `dev-status/**`, `plans/**`.
  Artifact names quoted in docs (`Memex_x.y.z_universal.dmg`,
  `Memex_x.y.z_x64-setup.exe`) follow `productName`, so update
  `app/README.md:106,107,183,184`, `README.md:74,75`, `docs/SIGNING.md:11`.
- `docs/memex-icon.png` — the only asset with the name in its filename
  (referenced `README.md:5`, `README-ko.md:5`). **App icons keep their images and
  their generic filenames** (`app/src-tauri/icons/icon.icns|ico|png`, `32x32.png`,
  `128x128*.png`) — user decision: icon art unchanged, name only.

**Two things a find-and-replace gets wrong:**

1. **The mascot sentences.** `README.md:164`, `app/CHANGELOG.md:336`,
   `MascotClip.tsx:1` read "MYCO, the Memex mascot" → a literal replace yields
   "MYCO, the myco mascot". Reword: the mascot's name became the product's name.
2. **`PageSettings.tsx:1668` hardcodes `v0.2.2 · build 2026.07.15`** and has never
   been bumped by any release — the version is already 0.3.0 in all three
   manifests. **Source it at runtime instead of re-hardcoding**: `@tauri-apps/api`
   is already a dependency (`app/package.json:45`) and its `getVersion()` is
   unused; it reads `tauri.conf.json`'s version. There is no build-date source at
   all — either drop the build date or inject it via a Vite `define`.

Nothing reads the product name at runtime anywhere (no `CARGO_PKG_NAME`, no
`productName` lookup), so every occurrence is a literal — there is no single
switch, and none of this can be verified by "it compiles".

**After the identifier flips**, re-check Stage A's I4 guard: anything that creates
`~/Library/Application Support/dev.cmblir.myco` before the migration runs (a Tauri
path API, an OS container) makes the migration skip permanently. Stage A added a
marker-file guard (`settings.json`/`active-vault`) for exactly this — confirm it
still holds once the identifier is real.

---

## 5. Push point

After Stage D the tree is coherent. Push the accumulated commits to `main`
(`git push origin main`). Do **not** tag yet.

---

## 6. Device verification — required before tagging

Unit tests prove none of this. Run an **old build** first, produce real state,
then the new one. Report exactly what you drove and what you could not.

1. **M1 app-data, macOS.** Old build → real settings, an open vault, a built
   embeddings index → quit → new build. Confirm `dev.cmblir.myco` holds
   `settings.json`, `active-vault`, `mcp-token`, `embeddings/` intact, the old dir
   is gone, and the app shows the same settings and vault. **Relaunch: nothing
   moves again.**
2. **MCP mirror.** With the app running, make an MCP tool call and confirm it
   resolves to the app's current vault; switch vaults in the app and repeat. Then
   the reverse order (server first, app second).
3. **Windows and Linux are completely unexercised** — only path strings are
   tested. On Windows the rename fails if any file in the dir is open by another
   process, which is the normal state when the MCP server is running.
4. **M2 keychain.** Store an API key and a Pro login under the old build; launch
   the new one; in Keychain Access confirm the items moved to `dev.cmblir.myco`
   with identical values and the old ones are gone; confirm a provider call still
   works. Then **lock the keychain and launch** — expect warnings only, no deleted
   entries. Once the build is signed, check whether macOS raises an ACL prompt per
   item (the binary's identity changed).
5. **M3 launchd.** Old build → enable a background schedule → confirm
   `~/Library/LaunchAgents/dev.cmblir.memex.digest.*.plist` and
   `launchctl list | grep cmblir`. New build → open that vault → confirm exactly
   **one** agent, new label only. Then a short cadence and confirm the digest fires
   **once**. Reopen the vault: no re-run.
6. **Deep link.** A bookmarklet saved with `memx://` must still work.
7. **B/C spot checks.** Onboarding does not re-appear; the last vault is
   remembered; saved graph looks survive; the ingest provider is still selected;
   the per-vault `.memex/` contents moved and schedules still run.

---

## 7. Stage E — GitHub repo rename

`cmblir/Memex` → `cmblir/myco`, update description and topics. GitHub redirects
old URLs, but update the local remote (`git remote set-url origin …`) and every
hardcoded link: `README.md:72,112,462,464,465,466`;
`README-ko.md:71,105,437,439,440,441`; `app/README.md:104`. Identifier-in-docs
also appears at `README.md:244,450`, `README-ko.md:236,429`,
`app/README.md:86,276`, `app/docs/E2E.md:128`, `app/PLAN.md:14,42`,
`app/scripts/smoke.sh:25-28`, `smoke_full.sh:18-21`,
`app/src/stores/settingsStore.ts:2`.

---

## 8. Stage F — Apple code signing (do this LAST, before the tag)

**The user has joined the Apple Developer Program and says the secrets are
already registered in GitHub.** Follow `docs/SIGNING.md` — it is a complete,
already-written guide.

Restore the `APPLE_*` env block in `.github/workflows/release.yml` (the comment
at the current env block says exactly what was removed and why).

**The trap, quoted from that comment:** an unset secret resolves to an **empty
string**, and `tauri-action` treats a present-but-empty `APPLE_CERTIFICATE` as
"sign", then runs `security import` with no data and **fails the whole macOS
bundle**. So: confirm the secrets actually exist before restoring the block, and
never restore it "in advance". **Never ask the user to paste secret values into
chat and never write them to a file** — they belong only in
repo Settings → Secrets and variables → Actions.

Windows signing is independent and can stay off.

---

## 9. Stage G — release v0.3.0 as myco

1. **Redo the release commit.** `17c49ae` (`chore(release): v0.3.0`) was written
   before the rebrand and is no longer the last commit. Re-create it on top so the
   tagged tree is fully myco: verify the version is `0.3.0` in `app/package.json`,
   `app/src-tauri/Cargo.toml`, `app/src-tauri/tauri.conf.json`,
   `app/src-tauri/Cargo.lock` (and `package-lock.json`), and that
   `app/CHANGELOG.md`'s `## [0.3.0] - 2026-07-28` section reads correctly under the
   new name.
   **The changelog deliberately omits two things — keep them omitted:** BM25
   fusion in the wikilink-suggestion path (measured worse, reverted) and the
   cross-encoder reranker (measured worse, behind an off-by-default feature).
   Neither ships, so neither is announced. Add a line about the rename itself.
2. `git push origin main`, then tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
   The tag triggers `.github/workflows/release.yml`, which builds a macOS universal
   `.dmg` and a Windows NSIS `.exe` on real runners and publishes a public GitHub
   Release. **This is the irreversible, outward-facing step — confirm with the user
   before pushing the tag.**
3. Watch the run (`gh run watch`). If the macOS job fails at signing, the most
   likely cause is the empty-secret trap in §8.
4. Download the produced `.dmg`, install it, and confirm on the real machine: it
   opens **without a Gatekeeper warning** (that is what signing bought), it is
   named myco, the About card shows 0.3.0, and §6's migrations held for a user
   upgrading from the installed v0.2.2.

---

## 10. Deferred — do not silently implement, do not silently drop

- **I2**: the keychain migration runs on **every** launch (no done-marker); on a
  locked keychain it can block startup. Comment at `secrets.rs:144-150`.
- **I5**: `open_vault` resolves a `python3` binary via a login shell before
  checking whether any legacy plist exists — reorder so the steady state costs
  zero processes. Comment at `commands.rs:200-205`.
- **M3 sweep**: vaults never reopened keep their old-label agents; once the app is
  renamed their `ProgramArguments` point at a path that no longer exists, so they
  fail forever with no UI to clean them up. A one-off startup sweep of
  `~/Library/LaunchAgents/dev.cmblir.memex.digest.*` would close it. Comment at
  `schedules.rs:402-406`.
- **`retire_legacy` ignores `launchctl unload`'s result** and deletes the plist
  regardless (`schedules.rs:315-324`) — pre-existing, not introduced by Stage A.
- **CI**: repo-wide `cargo fmt` drift and the two Windows path-assumption tests
  (§0). Fix as its own change, not inside a rebrand commit.
- The C1 test guard does not cover **doc-tests** or a **subprocess/relocated test
  binary** (both latent — the crate has zero executable doctests today). The
  Rust↔Python parity test **passes vacuously if `python3` is missing**.

---

## 11. How to work this

What worked for the retrieval increment and for Stage A, and is worth repeating:

- One stage at a time: implement → review → fix → **re-review** → next.
- Dispatch implementation and review to separate subagents; keep the controller's
  context for coordination. Reviews caught, among others, a bug where the lexical
  index never bootstrapped for existing users, two nondeterminism defects, an
  O(pages²) startup path, and the `cargo test` data-loss incident.
- Tell the reviewer **what to attack**, not just "review this" — name the state
  sequences you fear (partial migration, both dirs present, concurrent processes,
  a locked keychain, a failed install).
- Measurement beats opinion: this project's rule is "beat the recorded numbers or
  be dropped", and it has already retired two features that looked good on paper.
- Report what you did **not** verify as plainly as what you did.
