# Memex — Ralph Loop Prompt

> **DO NOT MODIFY OR DELETE THIS FILE DURING THE LOOP.**
> This file is the source of truth for ralph-loop iterations. Treat as read-only.

You are autonomously building **Memex** — a cross-platform desktop wiki app
(Tauri 2.0 + React, ships as `.dmg` / `.msi`) that replaces Obsidian as the
editor for this vault. Repo: `github.com/cmblir/Memex`.
Display name `Memex`, package/crate/bundle identifier `memex` (lowercase).

═══════════════════════════════════════════════════════════════════
## PER-ITERATION LOOP — DO EXACTLY THIS, NOTHING MORE
═══════════════════════════════════════════════════════════════════

1. Read `app/PLAN.md` and `app/PROGRESS.md`.
   If either is missing, create them from §SPEC at the bottom of this file
   and commit: `chore(memex): bootstrap PLAN and PROGRESS`
2. If on branch `main`, create and switch to `feat/memex-mvp`.
3. In `app/PROGRESS.md`, find the topmost `[ ]` item.
   If none, jump to step 8.
4. Implement that ONE item. Minimum scope. No drive-by refactors.
5. Verify in this exact order — abort step on first failure:
   - `cd app && npm install --no-fund --no-audit` (only if `package.json` or lockfile changed)
   - `cd app && npm run build` (frontend type-check + bundle)
   - `cd app/src-tauri && cargo check --quiet`
   - `cd app/src-tauri && cargo clippy --quiet -- -D warnings`
   - For Step 7 only: `cd app && npm run tauri build` and confirm
     `src-tauri/target/release/bundle/` contains `.dmg` or `.msi`.
6. On verification PASS:
   - `git add -A`
   - `git commit -m "<type>(memex): <subject>"` (Conventional Commits, English)
   - Mark the item `[x]` in `app/PROGRESS.md` and append a one-line note:
     `verified: <YYYY-MM-DD> <commit short-sha>`
   - `git add app/PROGRESS.md && git commit -m "chore(memex): mark <id> done"`
7. On verification FAIL after 3 attempts on the same item:
   - Append a section to `app/BLOCKED.md` with: item id, last full stderr,
     3 attempted approaches, hypothesis, what human input is needed
   - Mark the item `[B]` in `app/PROGRESS.md`
   - Commit: `chore(memex): block <id> pending human input`
   - Continue to next `[ ]` item.
8. If every line in `app/PROGRESS.md` is `[x]` or `[B]`:
   - Run final smoke build, ensure `.dmg` artifact exists.
   - Print a one-paragraph completion summary, then output exactly:
     `<promise>MEMEX MVP COMPLETE</promise>`

═══════════════════════════════════════════════════════════════════
## HARD CONSTRAINTS — VIOLATING ANY OF THESE = ABORT THE ITERATION
═══════════════════════════════════════════════════════════════════

- `raw/` and `wiki/` are READ-ONLY vault content. Never modify, delete, rename.
- `plans/memex-ralph-prompt.md` (this file) is READ-ONLY. Never edit.
- Never push. Never touch `origin/main`. No `--force`, no `reset --hard`,
  no `--no-verify`.
- Commit author = current `git config user.*`. NO Claude / AI attribution
  lines, no `Co-Authored-By: Claude`, no "Generated with" footers.
- All commit messages, code comments, JSDoc, README, error messages → **English**.
  (Korean prose belongs only to vault content under `wiki/`.)
- File ≤ 500 lines, function ≤ 50 lines, nesting ≤ 3 levels.
- Modular split:
  - **Rust** — `main.rs` / `commands.rs` (IPC) / `vault.rs` (FS) /
    `parser.rs` (frontmatter + wikilinks) / `index.rs` (SQLite cache)
  - **React** — `components/` (UI only) / `stores/` (Zustand) / `lib/` (pure helpers)
- New dependency ≥ 100 KB or with native build step → justify in commit body.
- No global state outside Zustand. No `any` in TypeScript (use `unknown`).
- Each commit must build — never commit a broken tree.

═══════════════════════════════════════════════════════════════════
## §SPEC — BOOTSTRAP CONTENT FOR `app/PLAN.md`
═══════════════════════════════════════════════════════════════════

```markdown
# Memex — desktop wiki app (MVP)

## Stack
- Shell: Tauri 2.0 (Rust + native WebView, no Chromium)
- Frontend: React 18 + Vite 5 + TypeScript 5
- Editor: CodeMirror 6 (@codemirror/lang-markdown, custom wikilink completion)
- Renderer: markdown-it + plugins for `[[wikilinks]]`, footnotes, callouts
- Graph: Cytoscape.js (fcose layout)
- State: Zustand 4
- Index/cache: SQLite via rusqlite (frontmatter, links, tags only —
  files remain source of truth)
- File watcher: notify crate
- Bundle targets: dmg (macOS), msi (Windows)
- Bundle identifier: dev.cmblir.memex

## Project layout
app/
├── package.json                       # name "memex", productName "Memex"
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── Editor.tsx
│   │   ├── Viewer.tsx
│   │   ├── BacklinksPanel.tsx
│   │   └── GraphView.tsx
│   ├── stores/vaultStore.ts
│   └── lib/{markdown.ts, wikilinks.ts, ipc.ts}
├── src-tauri/
│   ├── Cargo.toml                     # crate name "memex"
│   ├── tauri.conf.json
│   └── src/{main,commands,vault,parser,index}.rs
└── README.md                          # English

## Steps (one commit per `[ ]`, in order)

### S1 — Scaffold
- [ ] S1.1  Init Tauri 2 in app/  (`npm create tauri-app@latest -- --template react-ts`)
- [ ] S1.2  Set productName "Memex", identifier dev.cmblir.memex,
            bundle targets [dmg, nsis], window 1280×800
- [ ] S1.3  `npm run tauri dev` opens placeholder window cleanly
- [ ] S1.4  Add eslint + prettier; cargo fmt + clippy clean

### S2 — Vault IPC
- [ ] S2.1  Rust  `open_vault(path) -> VaultMeta`         — directory picker, canonical path
- [ ] S2.2  Rust  `list_files(root) -> FileNode[]`        — recursive .md walk (walkdir)
- [ ] S2.3  Rust  `read_file(path) -> {content, frontmatter}` (gray_matter)
- [ ] S2.4  Rust  `write_file(path, content)`             — atomic via tempfile + rename
- [ ] S2.5  vaultStore (Zustand): currentVault, fileTree, activeFile, openFile()

### S3 — Sidebar tree
- [ ] S3.1  Sidebar component renders FileNode[] from store
- [ ] S3.2  Click leaf → openFile()
- [ ] S3.3  Folder collapse/expand state persisted to localStorage
- [ ] S3.4  Resizable splitter, min 200px / max 600px

### S4 — Editor + Viewer
- [ ] S4.1  CodeMirror 6 mount with markdown lang, line numbers off, soft wrap
- [ ] S4.2  ⌘S triggers write_file; autosave on idle (2s debounce)
- [ ] S4.3  markdown-it preview with custom `[[wikilink]]` rule → `<a data-link>`
- [ ] S4.4  Mode toggle: source / preview / split (50/50)

### S5 — Wikilinks + Backlinks
- [ ] S5.1  Rust  `parse_links(path) -> Vec<String>`     — regex `\[\[([^\]]+)\]\]`
- [ ] S5.2  Rust  `build_link_graph() -> Adjacency`      — full vault scan, cached in SQLite
- [ ] S5.3  Click `<a data-link>` in preview → openFile(target)
- [ ] S5.4  BacklinksPanel: lists files where activeFile appears as wikilink target

### S6 — Graph view
- [ ] S6.1  Cytoscape.js mount; nodes = files, edges = wikilinks
- [ ] S6.2  fcose layout; default zoom fits all nodes
- [ ] S6.3  Click node → openFile()
- [ ] S6.4  Filter: tag chips + folder dropdown

### S7 — Build + Distribution
- [ ] S7.1  `npm run tauri build` produces .dmg on macOS host (verify file size > 5MB)
- [ ] S7.2  Smoke: installed app opens parent dir as vault, all S2–S6 features work
- [ ] S7.3  README.md (English): What is Memex / Install / Dev / Build / Architecture
- [ ] S7.4  Annotated git tag v0.1.0  (`git tag -a v0.1.0 -m "memex MVP"`)

## Acceptance
- App launches on macOS via the produced .dmg
- Opens this karpathy vault; sidebar lists every .md under raw/ and wiki/
- Editing wiki/foo.md saves to disk (verified by `git diff` after save)
- `[[wikilinks]]` resolve and click-navigate
- Backlinks panel populated for any file with inbound links
- Graph view renders 200+ nodes interactively (no jank on pan/zoom)
- Every commit on the branch passes cargo check + cargo clippy + npm run build
```

═══════════════════════════════════════════════════════════════════
## §SPEC — BOOTSTRAP CONTENT FOR `app/PROGRESS.md`
═══════════════════════════════════════════════════════════════════

```markdown
# Memex MVP — Progress

Mirror of PLAN.md step list. Update after every commit.
Legend: `[ ]` todo · `[x]` done · `[B]` blocked (see BLOCKED.md)

## S1 — Scaffold
- [ ] S1.1
- [ ] S1.2
- [ ] S1.3
- [ ] S1.4

## S2 — Vault IPC
- [ ] S2.1
- [ ] S2.2
- [ ] S2.3
- [ ] S2.4
- [ ] S2.5

## S3 — Sidebar tree
- [ ] S3.1
- [ ] S3.2
- [ ] S3.3
- [ ] S3.4

## S4 — Editor + Viewer
- [ ] S4.1
- [ ] S4.2
- [ ] S4.3
- [ ] S4.4

## S5 — Wikilinks + Backlinks
- [ ] S5.1
- [ ] S5.2
- [ ] S5.3
- [ ] S5.4

## S6 — Graph view
- [ ] S6.1
- [ ] S6.2
- [ ] S6.3
- [ ] S6.4

## S7 — Build + Distribution
- [ ] S7.1
- [ ] S7.2
- [ ] S7.3
- [ ] S7.4
```
