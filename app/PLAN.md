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
