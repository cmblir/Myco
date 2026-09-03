# Basics sprint — editor, sidebar, properties, portability, surface, live preview

**Date:** 2026-09-02 · **Status:** approved for implementation (synthesized from 6 drafts + 3 critiques; every `file:line` below re-verified at HEAD 376f951) · **Scope:** app (Rust + React)

## Why

Owner, verbatim fragment as relayed to the drafts: 「Obsidian이나 Notion에 비해 관리하기 힘들다」 — "compared with Obsidian/Notion it is hard to manage."

What that is at HEAD: the editor has only `[[` completion (Editor.tsx:98-122) — no `/` blocks, no find, no images, no outline; the file tree cannot move or multi-select and its context menu has no CSS (`.myco-menu`: 0 rules in styles.css, so it renders as a bare `<ul>` at the bottom of the aside); frontmatter is edited as raw YAML; saved Views live in localStorage and their save dialog is dead in the Tauri build (`window.prompt`, PageViews.tsx:106, swallowed by WKWebView per dialogStore.ts:1-3); the sidebar shows 15 rows before the page tree; the daily-note button uses the UTC day (Sidebar.tsx:517); the reader opens in Split and forgets the mode per file (PageReader.tsx:176).

## Scope (6 slices)

- **P5 Surface** — 6 primary routes + collapsible Tools + settings search; nothing removed, ⌘K reaches everything.
- **P3 Properties** — frontmatter as a form above the editor, Views cells editable, bulk type/status/tag; one lossless YAML-subset writer.
- **P6 Live** — a Live editor mode (default, persisted) that hides markdown marks off the cursor line, renders tasks/bullets/links, hides frontmatter.
- **P4 Portability** — saved Views in `.myco/views/*.json`, `templates/*.md` note templates, daily note on the local day.
- **P1 Editor basics** — `/` blocks, frontmatter `tags:` completion, ⌘F find/replace, image paste to `assets/`, outline pane; fixes `[[Note#H]]` creating `Note#H.md`.
- **P2 Sidebar** — multi-select, Move to…, favorites, recently edited, back/forward, styled + keyboard-operable context menu.

## Implementation order

| # | slice | why here | must assume already exists |
|---|---|---|---|
| 1 | P5 | No IPC/Rust; reshapes the top of Sidebar.tsx and the smoke selectors before P2's heavy edit of the same file. | nothing |
| 2 | P3 | Lands the foundations everyone else reuses: `frontmatter.ts`, `frontmatterLength`, `tagIndex.ts`, `saveFile({skipRefresh})`, `patchPages`, `ChipInput`, the Editor `viewRef` prop, `initialValue={draft}`, the PageReader re-seed effect, dark `color-scheme`. No Rust. | P5 (Sidebar shape irrelevant to P3) |
| 3 | P6 | Settles Editor.tsx (props `t`/`live`/`onLinkClick`, Compartment on P3's `viewRef`, `editorMode` store) before P1 piles completions/search/paste onto it; hides frontmatter now that P3 shows it as a form. | P3: `viewRef`, `frontmatterLength` |
| 4 | P4 | Independent Rust (`myco_json_*`); introduces the `pick` dialog P2's Move to… reuses; adds its menu item to the ContextMenu where it lives today (P2 moves the whole menu later). After P3 because both edit PageViews (P3 owns table/toolbar, P4 owns saved-view state/chips). | P3's PageViews; P1's anchor-strip not needed |
| 5 | P1 | Largest; three commits (P1a completions+find, P1b images, P1c outline). Builds on the settled Editor props and `frontmatterLength`/`tagCandidates`. | P3: `viewRef`, `tagCandidates`, `frontmatterLength`; P6: `t`/`live` props, `editorMode` |
| 6 | P2 | Heaviest Sidebar change; consumes P5's layout, P4's `pickDialog` + its menu item, P3's re-seed (bulk edits on the open note). | P5 nav layout; P4 `pickDialog`, `tpl_new_from` item; P3 re-seed effect |

Line numbers in this document are locators, not edit targets: a later slice greps for the anchor text. Later slices append keys/defaults/actions to uiStore — never reorder earlier bodies; no persist `version` bump anywhere (`merge` spreads persisted over defaults, uiStore.ts:166-182). README edits extend the current paragraph/table rather than replacing it.

## Shared helpers (single owner)

| helper | owner | where | consumers |
|---|---|---|---|
| Frontmatter parse/patch/serialize (`parseFrontmatter`, `patchFrontmatter`, `tagsOf`, `normalizeTag`) | P3 | `src/lib/frontmatter.ts` | P3 panel + Views. Nobody else writes YAML. |
| `frontmatterLength(md)` (length of the leading block, 0 if none) | P3 | `src/lib/markdown.ts` next to `stripFrontmatter` (26-29), which becomes `md.slice(frontmatterLength(md))`; `FRONTMATTER_RE` stays private | P3 `parseFrontmatter`, P6 frontmatter hide, P1c `bodyLineOffset`, P1a in-frontmatter test |
| Local date `today(now?)` | existing, taskLine.ts:192 | — | P4 daily + templates, P1a `/date` |
| Local time `localTime(now?)` (`HH:MM`) | P4 | `src/lib/templates.ts` | P4 |
| Tag index `tagCandidates(tags, query, limit)` | P3 | `src/lib/tagIndex.ts` (frequency desc, alpha, case-insensitive substring, unique) | P3 PropertiesPanel datalist, P1a tag completion. Views keeps `facetValues(...).tags` (queryViews.ts:158, existing, count-ranked) |
| `.myco` kind-scoped JSON commands (`myco_json_path`/`save_myco_json`/`list_myco_json`/`delete_myco_json`) | P4 | `src-tauri/src/commands.rs`, generalized from `dashboard_path` (1675-1684) | dashboards (unchanged signatures), views. P2's single-list `favorites.json` is written by `save_favorites` (create_dir_all + `vault::write_file`) and read with `ipc.readFile` — different shape, no second read idiom |
| Binary write IPC `write_asset` (raw body + `x-myco-name` header) | P1b | commands.rs / vault.rs | P1b |
| Navigation-open | existing | by path: `useUIStore.getState().setRoute(\`page:${abs}\`)`; by name (open-or-create): `vaultStore.openWikilink` / `createNoteAndOpen` (newNote.ts:32). P2 adds `replaceRoute` (no history entry) for rename/move path rewrites | all |
| Editor view handle | P3 | `EditorProps.viewRef?: MutableRefObject<EditorView | null>` set after `new EditorView` (Editor.tsx:82), nulled in cleanup. Final merged props: `{ docKey; initialValue; t: Strings; live: boolean; viewRef?; onChange?; onSave?; onLinkClick?; onError? }` — P3 adds `viewRef`, P6 adds `t`/`live`/`onLinkClick`, P1 adds `onError` | P3 `patchProps`, P6 Compartment, P1 scroll/paste |
| Pick dialog `pickDialog({ title, message?, body })` | P4 | `src/stores/dialogStore.ts` (`kind: "pick"`) | P4 templates, P2 Move to… |
| `normalizeQuery(s)` (NFC + locale lowercase + trim) | P5 | `src/lib/settingsSearch.ts` | P5 settings search, P1a slash filter |
| CodeMirror panel/tooltip colours | P1a | inside `EditorView.theme({...})` (Editor.tsx:66-72) — a stylesheet rule loses to CM's injected `&light` base theme (Editor.tsx:63-65) | — |

## Gates

`cd app && npm run lint && npx tsc -b && npx vitest run` · `cd app/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Every slice green on both before the next starts. `src/lib/i18n.parity.test.ts` enforces ko/ja completeness for every key below.

## Constraints

- `raw/` is immutable: no move/rename/delete/write into or out of `raw/` from any new path (Rust refuses; TS hides dead choices).
- Every user-visible string through i18n (en/ko/ja); comments English; Korean is the primary UI.
- New dependencies: none. `@codemirror/search` 6.7.0, `@codemirror/language` 6.12.3, `@lezer/common` 1.5.2 are already installed (node_modules, exact versions read from their package.json) but absent from `package-lock.json` `packages[""].dependencies` (lines 11-26) — CI runs `npm ci` (.github/workflows/ci.yml:32), which refuses a root-entry mismatch, so P1a/P6 add them to `package.json`, run `npm install`, and commit the lockfile in the same commit. Rust: `protocol-asset` adds the `http-range` crate to Cargo.lock (tauri-2.11.1/Cargo.toml:117 `protocol-asset = ["http-range"]`; absent from src-tauri/Cargo.lock today) — separate `build`-scoped commit.
- Logic in `src/lib/*.ts` pure functions with vitest (node, no jsdom); Rust commands testable through root-injected `*_at` helpers in `mod tests` with `tempfile::tempdir()`. Components thin.
- 3-file IPC parity for every new command: `ipc.ts` + `generate_handler!` (lib.rs:155-290) + `devMock.ts` `mockInvoke` case (a missing case rejects with `devMock: no handler`, devMock.ts:2801-2812).
- Accessibility: real `<button>`s, keyboard operable, visible focus, not colour-only.
- Not in this sprint: tabs/multi-pane, cloud sync/mobile, rename-updates-wikilinks.

## Out of scope / follow-ups (sprint-level)

HTML5 in-webview drag-and-drop is non-functional in the macOS build (tauri-runtime-wry-2.11.1 src/lib.rs:4861-4892 registers a drag-drop handler that returns `true` unconditionally; wry-0.55.1 src/wkwebview/drag_drop.rs:60-95 forwards `draggingUpdated`/`performDragOperation` to WebKit only when it returns `false`; tauri.conf.json sets no `dragDropEnabled`). So: no sidebar drag-to-move (P2 ships Move to…), no editor image drop (P1b ships paste; drop via `onDragDropEvent` is a follow-up), and TaskBoard.tsx:82-88 / TaskCalendar.tsx:80-88 DnD is a pre-existing latent break to fix separately. Also deferred: body `#tag` indexing (`index.rs::extract_tags` is frontmatter-only), heading-anchor navigation/completion, image drop, sidebar bulk tag (Views has it), settings deep-links, Split-mode removal, portable-bundle entries for the new uiStore keys.

---

# P5 Surface reduction — 6-item primary nav, collapsed Tools, settings search

## Goal (2 lines) & how it reduces "hard to manage" vs Obsidian/Notion
Sidebar: 2 quick actions + 6 primary routes + a Tools disclosure + Settings = 10 rows above the page tree (was 15); no route removed, ⌘K reaches all 13. Settings gets a search box that narrows the tab rail and the cards to text matches in the current UI language.
Decision (default, owner may override): **6 primary, not 5** — Views becomes the bulk-edit surface in P3 and Overview is the boards dashboard the owner just built and the landing route; burying either costs more than one row. Obsidian shows ~6 ribbon items and has settings search; Notion's sidebar has ≤6 sections.

## UX behavior
Sidebar (`src/components/Sidebar.tsx`), top → bottom:
1. `.side-quick`: Search ⌘K, Today's note. The Ingest and Ask quick buttons (113-130) are removed — they were routes; rule after this change: quick row = actions, nav = routes.
2. `.nav-group` Workspace, exactly: **Overview** (home) · **Ask** (`msg`, route `query`, `t.nav_query`) · **Ingest** (`upload`, `t.nav_ingest`) · **Graph** · **Tasks** (`check`) · **Views** (`eye`).
3. **Tools row** — `<button className="nav-item" aria-expanded={toolsOpen}>` styled like a folder row (`ni-caret` + `.open`, `chevR`, Sidebar.tsx:347-352 idiom), icon `dotMore`, label `t.nav_tools`. Click/Enter/Space toggles `uiStore.toolsOpen` (per device; default `false`; not in `settingsBundle` `UI_KEYS`). Collapsed and `route ∈ TOOL_ROUTES` → `.active`. Collapsed and `dueTotal + pendingProposals > 0` → `.nav-badge` with the sum and `title`/`aria-label` = `` `${t.nav_study} ${dueTotal} · ${t.nav_feedback ?? "Feedback"} ${pendingProposals}` `` (no new key). Open → 6 indented NavItems moved verbatim: History, Provenance, Tags, Study (badge), Feedback (badge), Schedules; header shows no badge.
4. `.nav-group` Pages — unchanged.
5. `.side-tools` (229-243) — Settings only; the "Tools" group label there is dropped.
Command bar: `{ type: "nav", label: t.nav_views ?? "Views", to: "views" }` after the `tasks` entry (CommandBar.tsx:133); `iconFor` gets `if (entry.to === "views") return "eye";` (387-401).
Settings search (`src/pages/PageSettings.tsx` 92-175 only): `<input type="search" className="input" maxWidth 360>` between `.page-head` and `.settings-grid`, `placeholder`/`aria-label` = `t.s_search_ph`, not autofocused. Rail = tabs with ≥1 label match from `SETTINGS_INDEX` (inactive tabs are unmounted, so cross-tab needs the index). If the current tab drops out, the first matching tab becomes active (in the change handler, so it sticks after clearing). Cards in the active tab: a `.card` whose own `textContent` does not contain the query gets `.s-hide` — the query, not the index, so an un-indexed card fails open (visible); a tab-title match shows all cards. Empty state: rail empty, body `<div className="muted" role="status">` with `t.s_search_empty` `{q}` filled. Escape clears. IME: keep `value` controlled on every change, but run match/tab-switch/empty-state only when `!isComposingKey(e)` (src/lib/ime.ts:42) and again in `onCompositionEnd`. States: idle / filtering / empty; no loading/error (in-memory strings).

## Files to touch (existing) / Files to create
Touch: `src/components/Sidebar.tsx` (104-131, 133-243, `NavItem` 264-289), `src/stores/uiStore.ts`, `src/components/CommandBar.tsx`, `src/pages/PageSettings.tsx`, `src/lib/i18n.ts`, `src/styles.css`, smoke scripts: `scripts/agent-smoke.mjs:37`, `scripts/ask-stages-smoke.mjs:51`, `scripts/query-smoke.mjs` (`.side-quick .qbtn` Ask → `.side-nav .nav-item` `/^Ask$|질문|質問/`), `scripts/import-smoke.mjs:35` (`.qbtn` Ingest → `.side-nav .nav-item`), `scripts/history-a11y-smoke.mjs:29` (click `.side-nav .nav-item[aria-expanded]` first), `scripts/capture-shots.mjs:22-25,45-59` (nav index comment → overview 0 · ask 1 · ingest 2 · graph 3 · tasks 4 · views 5; Provenance/Tags shots open Tools first), `scripts/clip-smoke.mjs:43` (use `.side-tools .nav-item`), `app/README.md` `### Interface` (95-108): one bullet.
Create: `src/lib/settingsSearch.ts`, `src/lib/settingsSearch.test.ts`.

## New/changed functions & types
```ts
// uiStore.ts — UIState after `sidebarCollapsed` (l.58); default after l.113; action after l.138
toolsOpen: boolean;            // default false
toggleTools: () => void;       // () => set({ toolsOpen: !get().toolsOpen })

// Sidebar.tsx
const TOOL_ROUTES: RouteId[] = ["history", "provenance", "tags", "study", "feedback", "schedules"];
// NavItem gains `indent?: boolean` → style={indent ? { paddingLeft: 18 } : undefined} (depth-1 tree indent, Sidebar.tsx:349)

// src/lib/settingsSearch.ts
export type SettingsTab = "account" | "model" | "providers" | "mcp" | "distill" | "lang" | "appearance" | "about";
/** Tab title key FIRST, then each card title key. Drives the rail only; cards filter by their own text. */
export const SETTINGS_INDEX: Record<SettingsTab, (keyof Strings)[]> = {
  account: ["s_account", "s_local_user", "s_vault_known"],
  model: ["s_model", "s_model_query", "s_model_ingest", "s_autoimport_title", "s_autoingest_title", "s_autoreflect_title", "s_budget_title", "s_embeddings", "s_autoreindex_title"],
  providers: ["s_providers"],
  mcp: ["s_mcp", "mcp_command_label"],
  distill: ["s_distill", "set_distill_enabled_title", "set_distill_profile_injection_title", "set_profile_title", "set_distill_status_title", "vh_setting_title", "set_pii_title", "set_audit_title", "set_archive_title"],
  lang: ["s_lang", "s_lang_ui"],
  appearance: ["s_appearance", "s_appearance_light", "s_appearance_dark", "s_appearance_system", "s_mascot", "s_ov_theme", "s_tray_resident_title", "s_notch_title", "s_spot_title"],
  about: ["s_about", "up_check", "s_backup_title", "cr_last_crash"],
};
export function normalizeQuery(s: string): string;                       // s.normalize("NFC").toLocaleLowerCase().trim()
/** Per tab, resolved labels containing `query`; tabs with no match absent; blank query → every label; missing optional keys skipped. */
export function matchSettings(t: Strings, query: string): Map<SettingsTab, string[]>;
```
PageSettings: `const [q, setQ] = useState("")`, `const [applied, setApplied] = useState("")` (the last non-composing value), `matches = useMemo(() => matchSettings(t, applied), [t, applied])`, `bodyRef` on the body column; card effect:
```ts
useEffect(() => {
  const root = bodyRef.current; if (!root) return;
  const nq = normalizeQuery(applied);
  const showAll = !nq || (matches.get(tab) ?? []).includes(t[SETTINGS_INDEX[tab][0]] ?? "");
  const apply = () => root.querySelectorAll<HTMLElement>(".card").forEach((el) =>
    el.classList.toggle("s-hide", !showAll && !normalizeQuery(el.textContent ?? "").includes(nq)));
  apply();
  const mo = new MutationObserver(apply);            // cards that render after an IPC load
  mo.observe(root, { childList: true, subtree: true }); // childList only: toggling a class never retriggers
  return () => mo.disconnect();
}, [applied, matches, tab, t]);
```
`styles.css` after `.settings-grid` (l.891-896): `.s-hide { display: none !important; }` (beats `.card.row/.col` and MycoProCard's inline grid).

## IPC additions
None.

## i18n keys
Add (interface next to `s_title` l.617; en after 2052; ko after 3512; ja after 4803), remove `quick_ingest` (interface l.8, en 1395, ko 2859, ja 4316; its only reader is the removed button — `quick_ask` stays: trayStatus.ts:207).

| key | en | ko | ja |
|---|---|---|---|
| `s_search_ph?` | Search settings | 설정 검색 | 設定を検索 |
| `s_search_empty?` `// {q}` | No settings match “{q}” | “{q}”에 해당하는 설정이 없습니다 | 「{q}」に一致する設定はありません |

## Tests
`src/lib/settingsSearch.test.ts` (imports `STRINGS`): (1) `matchSettings(STRINGS.en, "")` has all 8 tabs, `get("model")` has 9 labels; (2) `"spend"` → only `model`, labels `["Monthly spend guard"]` (i18n.ts:2735); (3) `"  SPEND "` equals (2); (4) `"budget"` → `size === 0` (labels, not key names, are searched); (5) `"language"` → `get("lang")` includes `STRINGS.en.s_lang`; (6) `matchSettings(STRINGS.ko, "월 지출")` → `model` with `["월 지출 가드"]` (i18n.ts:4194) and `"Monthly spend"` → `!has("model")`; (7) `"언어".normalize("NFD")` → has `lang`; (8) `"zz-no-such-setting"` → `size === 0`; (9) index integrity: for en/ko/ja every `SETTINGS_INDEX` key resolves to a non-empty string.
Browser (`?mock=1`): type "spend" → rail shows Model, only the spend card visible; clear → all back; Tools toggle persists across reload; ⌘K lists Views. Re-run `test:e2e:history`, `ask`, `agent`, `query`, `import`, `clip`.

## Edge cases & failure handling
Deep-link into a collapsed tool route → header `.active`, no auto-expand. Old `myco-ui` without `toolsOpen` → `false` via merge. ≤768px collapse/scrim logic (App.tsx:500-513) untouched. Nested cards (MCP code box in a col): parent text ⊇ child text — consistent. Theme swatches are `<button className="card">` and filter by their own labels. A card missing the `.card` class is never hidden (fails open).

## Estimated diff size (lines) and risk
Sidebar −30/+50 · uiStore +4 · CommandBar +2 · PageSettings +45 · i18n +8/−4 · styles +3 · settingsSearch +45 · test +55 · 7 smokes ≈ +12/−8 · README +1 ≈ **+225 / −45**. Risk: low; the smoke selectors are the breakage vector and are enumerated.

## Follow-ups explicitly excluded
Card descriptions/provider names as search terms; `settings:<tab>` deep-link route; Topbar breadcrumb for tasks/tags/views/study/feedback/schedules; density/accent Settings UI.

---

# P3 Properties — panel + inline Views editing

## Goal (2 lines) & how it reduces "hard to manage" vs Obsidian/Notion
Every note's frontmatter becomes a form (typed controls for `type`/`status`/`confidence`/`source_count`/`tags`, key/value rows for the rest) that writes back only the frontmatter range; the Views table becomes editable per cell and in bulk. Obsidian's properties form + Notion's table editing, over plain files, with one lossless YAML-subset writer that every later slice must use.

## UX behavior
**Reader (VaultPage).** A `<details className="card-flat props">` directly under `</header>` (PageReader.tsx:431), above the editor section; `<summary>` = `t.props_title · N`; open state = `uiStore.propsCollapsed` (default open). Hidden under `<vault>/raw/`. Rows in file order: key (mono, untranslated YAML key) · control · `×` (`aria-label` `props_remove`). `type`/`status`/`confidence` → `<select className="input">` of canonical values + the current non-canonical value; change applies immediately. `source_count` → `<input type="number" min=0 step=1>`, commit on blur/Enter. `tags` → `ChipInput` (datalist of `tagCandidates(adjacency.tags, "", Infinity)`); each add/remove writes. Other scalars → `<input type="text">`, commit on blur/Enter if changed, Escape restores; `parseScalar` coerces `true/false/number/""` back so a no-op edit never changes type. Nested / block values → `t.props_complex`, still removable. "＋ Add property" → inline key/value row; Enter/Add commits; invalid or duplicate key → `role="alert"` `props_bad_key`. **No frontmatter** → one line: the Add button only (no empty form on daily notes; Obsidian shows nothing until a property exists).
Edits enter the CodeMirror doc as one transaction over `[0, end)` through `viewRef` → cursor/scroll kept, **⌘Z undoes a property edit**, the existing 2 s autosave persists it. In Preview (editor unmounted) the draft is patched directly and autosave scheduled. Save errors surface through the already-rendered `vaultStore.error` (PageReader.tsx:173).
**Views (PageViews).** New first column: checkbox per row (`aria-label` `vw_select_row`) + header checkbox (all visible). Type/Status cells: `<button className="views-cell">` (value or `—`, `title` `vw_edit_cell`); click/Enter → `<select autoFocus>` (`vw_unset` + canonical + present values); change applies and closes; Escape/blur closes; focus returns to the re-mounted cell button via `autoFocus`. Tags cell → `ChipInput` + `vw_edit_done` button. When ≥1 selected: `role="toolbar"` above the table: `pill` `{n} selected ×` (clears) + `Set type…` + `Set status…` + `Add tag…` (3 actions, ≤4 controls). Each asks `confirmAction` `vw_bulk_confirm`, runs `patchPages`; controls disabled while busy; failure shown in the toolbar; one graph refresh at the end.

## Files to touch (existing) / Files to create
Create: `src/lib/frontmatter.ts` + `.test.ts`, `src/lib/tagIndex.ts` + `.test.ts`, `src/components/PropertiesPanel.tsx`, `src/components/ChipInput.tsx` (verbatim move of `ChipInput` from TaskComposer.tsx:26-96, exported, plus `removeTitle?: string` defaulting to the current `"remove"`).
Touch: `src/lib/markdown.ts` (add `frontmatterLength`), `src/components/TaskComposer.tsx` (import ChipInput), `src/components/Editor.tsx` (`viewRef` prop, 4 lines), `src/pages/PageReader.tsx`, `src/pages/PageViews.tsx`, `src/stores/vaultStore.ts` (`saveFile` opts, `patchPages`), `src/stores/uiStore.ts` (`propsCollapsed`), `src/lib/i18n.ts`, `src/styles.css`, `src/stores/vaultStore.test.ts`.

## New/changed functions & types
```ts
// src/lib/markdown.ts
/** Length of the leading frontmatter block (FRONTMATTER_RE, l.23), 0 if none. */
export function frontmatterLength(md: string): number;   // FRONTMATTER_RE.exec(md)?.[0].length ?? 0
export function stripFrontmatter(md: string): string;    // md.slice(frontmatterLength(md))

// src/lib/frontmatter.ts
export type FmScalar = string | number | boolean | null;
export type FmValue = FmScalar | string[];
/** `src` = exact source text of the key line + continuations (each with its eol); untouched entries are re-emitted from it — that is the lossless round trip. `value` undefined = nested map / block scalar (read-only). */
export interface FmEntry { key: string; value: FmValue | undefined; src: string }
export interface Frontmatter { head: string; entries: FmEntry[]; end: number; eol: "\n" | "\r\n" }
export type FmPatch = Record<string, FmValue | undefined>;          // undefined = remove
export interface FmEdit { raw: string; to: number; insert: string } // replace raw[0,to) with insert
export const FM_TYPES = ["concept","entity","technique","source-summary","analysis","map","overview","meta"] as const; // local_llm.rs:42-49 + validator.rs:20
export const FM_STATUS = ["active","superseded","disputed"] as const;   // validator.rs:42
export const FM_CONFIDENCE = ["high","medium","low"] as const;          // validator.rs:41
export function parseFrontmatter(raw: string): Frontmatter | null;       // end = frontmatterLength(raw); 0 → null
export function getValue(fm: Frontmatter | null, key: string): FmValue | undefined;
/** `tags` as index.rs:253-273 extract_tags sees it: array, or a comma string split. */
export function tagsOf(fm: Frontmatter | null): string[];
export function parseScalar(text: string): FmScalar;
export function serializeFrontmatter(fm: Frontmatter): string;           // "" when head+entries empty
export function patchFrontmatter(raw: string, patch: FmPatch): FmEdit;
/** Trim, drop a leading '#'; null for empty / whitespace / ',' / '[' / ']'. */
export function normalizeTag(input: string): string | null;

// src/lib/tagIndex.ts
/** Unique tags of Adjacency.tags (ipc.ts:56-71), frequency desc then alpha, case-insensitive substring filter. */
export function tagCandidates(tags: Record<string, string[]>, query = "", limit = 30): string[];
```
Parse rules (line-based YAML subset; anything outside it is preserved verbatim and shown read-only): block = `raw.slice(0, frontmatterLength(raw))`; eol from the first line; inner lines split on `/\r?\n/`, fences dropped. Key line `/^([A-Za-z0-9_][\w.-]*):(?:[ \t]+(.*?))?[ \t]*$/` at column 0 starts an entry; other lines append to the current entry's `src` (or `head` before the first key). Classification ignoring blank/`#` continuations: inline value, no continuation → scalar (`[a, b]` → `string[]`); no inline, all continuations `^\s+-\s*(.*)$` → `string[]`; no inline, none → `null`; else `undefined`. `parseScalar`: strip unquoted ` #comment`; `"…"` → `JSON.parse` (fallback strip); `'…'` → strip, `''`→`'`; `~`/`null`/`""` → null; `true|false`; `/^-?\d+(\.\d+)?$/` → number; else string. Serialize scalar: number/boolean bare; null → `key:`; string bare iff `/^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*$/u`, equals its trim, and is not `true|false|null|yes|no|on|off|~` or number-looking (case-insensitive) — else `JSON.stringify`. Lists: `key:` + `  - item` lines (mcp_native.rs:1478-1509 style); empty → `key: []`. `patchFrontmatter`: parse (or empty with the body's eol); remove / replace first match in place / append; `insert = serializeFrontmatter(next)`; `raw = insert + raw.slice(cur.end)`. Body bytes never touched.

```ts
// src/components/Editor.tsx — P3's only change
export interface EditorProps { docKey; initialValue; viewRef?: MutableRefObject<EditorView | null>; onChange?; onSave? }
// after l.82: if (viewRef) viewRef.current = view;   cleanup: if (viewRef) viewRef.current = null;

// src/stores/vaultStore.ts
saveFile: (path: string, content: string, opts?: { skipRefresh?: boolean }) => Promise<void>; // impl l.189: if (!opts?.skipRefresh) void get().refreshLinkGraph();
/** Read → patch → saveFile({skipRefresh}) per path, one refreshLinkGraph at the end; first failure stops the loop and lands in `error`. */
patchPages: (paths: string[], make: (fm: Frontmatter | null) => FmPatch) => Promise<void>;

// src/stores/uiStore.ts
propsCollapsed: boolean;  setPropsCollapsed: (v: boolean) => void;   // default false, persisted

// src/pages/PageReader.tsx (VaultPage)
const editorViewRef = useRef<EditorView | null>(null);
const fm = useMemo(() => parseFrontmatter(draft), [draft]);
const allTags = useMemo(() => tagCandidates(adjacency?.tags ?? {}, "", Infinity), [adjacency]);
const isRaw = !!currentVaultPath && path.startsWith(`${currentVaultPath}/raw/`);
function patchProps(patch: FmPatch): void {
  const edit = patchFrontmatter(draftRef.current, patch);             // draftRef: PageReader.tsx:188
  const v = editorViewRef.current;
  if (v) v.dispatch({ changes: { from: 0, to: Math.min(edit.to, v.state.doc.length), insert: edit.insert } }); // → updateListener → onChange → scheduleSave
  else { setDraft(edit.raw); scheduleSave(edit.raw); }                 // preview mode
}
// <Editor docKey={path} initialValue={draft} viewRef={editorViewRef} …>
//   `draft`, not `activeFile.raw` (l.444): Editor reads initialValue only on docKey change, and a
//   preview-mode property edit must survive a Preview→Source switch inside the 2 s autosave window.
// Re-seed when another surface (Views bulk edit, P2 move) rewrote this note while the draft is clean:
const [seedGen, setSeedGen] = useState(0);   // Editor docKey={`${path}#${seedGen}`}
// inside the seed effect (227-236), else-branch:
// if (activeFile?.path === path && seededPathRef.current === path && activeFile.raw !== seededRawRef.current
//     && draftRef.current === seededRawRef.current) { setDraft(raw); draftRef.current = raw; seededRawRef.current = raw; setSeedGen(g => g + 1); }
// ponytail: a dirty draft is left alone — its pending autosave wins. Autosave sets seededRawRef before saveFile (262, 270), so its own activeFile.raw update never re-seeds.

// src/components/PropertiesPanel.tsx
export default function PropertiesPanel({ fm, allTags, onPatch, t }: { fm: Frontmatter | null; allTags: string[]; onPatch: (p: FmPatch) => void; t: Strings }): JSX.Element;
const KEY_RE = /^[A-Za-z_][\w-]*$/;

// src/pages/PageViews.tsx
type CellKey = "type" | "status" | "tags";
const [selected, setSelected] = useState<Set<string>>(new Set());
const [editing, setEditing] = useState<{ path: string; key: CellKey } | null>(null);
const [busy, setBusy] = useState(false);
const patchPages = useVaultStore((s) => s.patchPages); const storeErr = useVaultStore((s) => s.error);
async function bulk(make: (fm: Frontmatter | null) => FmPatch): Promise<void> {
  const paths = rows.filter((r) => selected.has(r.path)).map((r) => r.path);
  if (!(await confirmAction({ title: t.vw_bulk_title ?? "Bulk edit", message: (t.vw_bulk_confirm ?? "Apply to {n} pages?").replace("{n}", String(paths.length)) }))) return;
  setBusy(true); try { await patchPages(paths, make); } finally { setBusy(false); }
}
// add tag: bulk((fm) => ({ tags: [...new Set([...tagsOf(fm), tag])] })) after normalizeTag(tag)
// select options: [...new Set([...FM_TYPES, ...(facets?.types.map(f => f.value) ?? []), current])]; tag datalist = facets?.tags.map(f => f.value)
```
`styles.css`: `.props`, `.props summary`, `.props__row` (grid `140px 1fr auto`), `.props__key` (mono), `.views-cell` (dashed underline on hover/focus — editability not by colour alone), and `:root[data-theme="dark"] { color-scheme: dark; }` + `.props input[type=checkbox], .views-check input { accent-color: var(--ink); }` (native select/number/checkbox chrome was light on the dark theme; 0 `color-scheme` rules today).

## IPC additions
None. `write_file` confines, refuses overwriting existing `raw/` files (commands.rs:385-387) and marks the index dirty. Under `?mock=1` read/write round-trip through `mockNotes` (devMock.ts:2153, 2508-2518); the mock link graph is static, so Views cells need a real vault.

## i18n keys (optional; `props_*` after the `rd_*` block, `vw_*` after `vw_lens_*` l.182)
| key | en | ko | ja |
|---|---|---|---|
| props_title | Properties | 속성 | プロパティ |
| props_add | Add property | 속성 추가 | プロパティを追加 |
| props_key_ph | key | 키 | キー |
| props_value_ph | value | 값 | 値 |
| props_add_confirm | Add | 추가 | 追加 |
| props_remove | Remove {key} | {key} 제거 | {key} を削除 |
| props_bad_key | Key must start with a letter, use only letters, digits, _ or -, and not already exist | 키는 영문자로 시작해 영문·숫자·_·-만 사용할 수 있으며 이미 있는 키는 쓸 수 없습니다 | キーは英字で始まり英数字・_・-のみ使用でき、既存のキーは使えません |
| props_complex | Complex value — edit in source | 복합 값 — 소스에서 편집하세요 | 複合値 — ソースで編集してください |
| props_tags_ph | Add tag… | 태그 추가… | タグを追加… |
| props_tag_remove | Remove tag | 태그 제거 | タグを削除 |
| vw_select_all | Select all rows | 모든 행 선택 | すべての行を選択 |
| vw_select_row | Select {name} | {name} 선택 | {name} を選択 |
| vw_selected_n | {n} selected | {n}개 선택됨 | {n} 件選択中 |
| vw_bulk_title | Bulk edit | 일괄 편집 | 一括編集 |
| vw_bulk_confirm | Apply to {n} pages? | {n}개 페이지에 적용할까요? | {n} ページに適用しますか？ |
| vw_bulk_type | Set type… | 유형 설정… | タイプを設定… |
| vw_bulk_status | Set status… | 상태 설정… | ステータスを設定… |
| vw_bulk_add_tag | Add tag… | 태그 추가… | タグを追加… |
| vw_clear_sel | Clear selection | 선택 해제 | 選択を解除 |
| vw_edit_cell | Click to edit | 클릭하여 편집 | クリックして編集 |
| vw_unset | (none) | (없음) | (なし) |
| vw_edit_done | Done | 완료 | 完了 |
| vw_edit_failed | Could not save: {msg} | 저장 실패: {msg} | 保存できませんでした: {msg} |

## Tests
`src/lib/frontmatter.test.ts`: (1) `parseFrontmatter` null for no block / unterminated / mid-doc `---`; CRLF → `eol "\r\n"`. (2) Lossless round trip over fixtures (vault.rs:794-799 stub incl. `tags:` null; block-list tags; flow list; quoted; `#` comment lines; nested `sources:\n  a: 1`; block scalar `notes: |`; blank lines; trailing-comment scalar; CRLF): `serializeFrontmatter(parse(raw)) + raw.slice(end) === raw`. (3) Order + classification (`type→"concept"`, `tags:`→null, `source_count: 3`→3, `title: "A: b"`→`"A: b"`, nested→undefined, `status: active # todo`→`"active"`). (4) Patch existing scalar: only that line changes, other `src` byte-equal, body identical, `to === old end`. (5) New key appends before the fence; remove deletes the block incl. continuations; removing the last entry → `insert === ""`. (6) No frontmatter: inserts `---\nkey: v\n---\n`; CRLF body → CRLF block. (7) `tagsOf` for array / `"a, b"` / null; `{tags:["a","b"]}` → block list; `{tags:[]}` → `tags: []`. (8) Quoting table (`"true"`, `"3"`, `"- x"`, `"a: b"`, `"x #y"`, `""`, `" lead"` quoted; `high`, `2026-08-13`, `한국어 제목`, `source-summary` bare; `parseScalar(fmt(v)) === v`). (9) Duplicate key → first occurrence. (10) `normalizeTag`: `" #foo "`→`foo`; `""`, `"a b"`, `"a,b"`, `"[x]"` → null.
`src/lib/tagIndex.test.ts`: dedupes across pages, frequency then alpha, case-insensitive filter, limit.
`src/lib/markdown.test.ts` (extend): `frontmatterLength` equals what `stripFrontmatter` removes for the 5 existing fixtures.
`src/stores/vaultStore.test.ts` (extend, `vi.spyOn(ipc, …)` idiom l.16-22): `saveFile(..., {skipRefresh:true})` never calls `buildLinkGraph`, without opts it does; `patchPages([a,b])` writes only changed files, calls `buildLinkGraph` once, updates `activeFile.raw` for the open path, stops on the first `readFile` rejection and sets `error`.
Browser (`?mock=1`): change type via select → only the `type:` line changes in Source; ⌘Z reverts; Preview → add tag → Source: tag present; note without frontmatter → Add creates the block.

## Edge cases & failure handling
raw/: panel hidden under `raw/`, Views rows are `wikiPagesOnly` (queryViews.ts:78), backend refuses anyway. Untouched entries re-emitted from `src`; on an edit only: fence whitespace trimmed, final newline added, mixed EOLs unified, an edited scalar loses its trailing comment. Empty `---\n---\n` does not match `FRONTMATTER_RE` (pre-existing) → treated as no frontmatter; accepted. Keys with spaces fold into the previous entry → complex/read-only, lossless. `tags` typed as a comma string via Add stays a string until the next chip edit. Open note rewritten by Views: clean draft → re-seed; dirty draft → the draft's autosave wins (documented). Re-parse per keystroke is bounded by the block (lazy regex). States: empty / read-only rows / invalid key alert / save error banner; Views: `busy` disables controls, `storeErr` in the toolbar.

## Estimated diff size (lines) and risk
≈ +900 / −70: frontmatter.ts 160, test 140, tagIndex 15+25, PropertiesPanel 170, ChipInput +72/TaskComposer −68, Editor +5, PageReader +40, PageViews +120, vaultStore +25 (+25 test), uiStore +4, markdown +5, i18n ~96, styles ~50. Risk: medium — the two sharp edges (live CM transaction, YAML round trip) are pinned by the byte-equality tests and the existing onChange/autosave path.

## Follow-ups explicitly excluded
Merging a bulk edit into a dirty draft; `created` as `<input type="date">`; boolean checkboxes; key rename/reorder; bulk remove tag / bulk confidence; Views undo; `propsCollapsed` in `settingsBundle`.

---

# P6 Live preview editor mode

## Goal (2 lines) & how it reduces "hard to manage" vs Obsidian/Notion
A `Live` mode (new default, persisted per device) renders markdown in place — heading sizes, `**`/`*`/`` ` ``/`# `/`[[ ]]` marks hidden except on the cursor line, `•` bullets, clickable task checkboxes, quote bar, wikilinks as links (Mod-click opens), frontmatter hidden (P3's form shows it). One surface that reads like Preview while typing; zero new dependencies (Lezer tree already installed via `@codemirror/lang-markdown`).

## UX behavior
- `.segmented` in the reader header (PageReader.tsx:395-414) becomes **Live · Source · Split · Preview**; Live default; mode persisted in `uiStore.editorMode` (no more reset-to-Split per file). Decision: Split kept — removing a shipped mode was not requested; revisit once Live has been used.
- Live = Editor alone; same autosave / ⌘S / completions as Source. Live⇄Source reconfigures a Compartment: cursor, scroll and undo history survive.
- On every line without a selection head: `# `, `**`, `*`, `` ` ``, `~~`, `> `, `[`+`](url "title")` (two hidden ranges), `[[`/`]]` and a wikilink's `target|` are collapsed; headings sized like `.prose`; `-`/`*`/`+` bullets → `•`; `[ ]`/`[x]` → native `<input type="checkbox">`; blockquote bar; links/wikilinks underlined. Caret on a line reveals its raw markdown (all lines of every selection range). Fenced/indented code, images, HTML blocks, bare `[text]` (Lezer `Link` without `URL`) stay raw.
- Frontmatter in Live is replaced by one block widget line (`t.rd_frontmatter_hidden`); it is not editable in Live — the Properties panel or Source is. In Source/Split it is plain text.
- Mouse: click a checkbox toggles `[ ]`⇄`[x]` (autosaves). Mod-click on a wikilink → `handleLinkClick` (same as the Viewer, PDF pinpoints included). Plain click places the caret (edit-first; a decision — Obsidian follows on plain click). Keyboard: checkbox is Tab-focusable, Space toggles, `:focus-visible` ring. No `Mod-Enter` binding (`defaultKeymap` binds it to `insertBlankLine`, @codemirror/commands dist/index.js:1692, and would shadow it). HelpWidget gains "⌘click — open wikilink (Live)".

## Files to touch (existing) / Files to create
Create: `src/lib/editorLive.ts` (~180), `src/lib/editorLive.test.ts`.
Touch: `src/components/Editor.tsx`, `src/pages/PageReader.tsx`, `src/stores/uiStore.ts`, `src/components/HelpWidget.tsx` (65-73), `src/lib/i18n.ts`, `src/styles.css` (one `/* Live preview */` block after 2448), `package.json` + `package-lock.json` (declare `"@codemirror/language": "6.12.3"`, `"@lezer/common": "1.5.2"`; `npm install`), `app/README.md:45` (Writing row → "Live / Source / Split / Preview"), root `README.md:249-252` and `README-ko.md:239-242` Reader paragraph (+ "Live editing").

## New/changed functions & types
```ts
// src/lib/editorLive.ts
import type { Tree } from "@lezer/common";
import { StateField, Text, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";          // d.ts:182
import { matchWikilinkAt } from "./wikilinks";               // wikilinks.ts:25
import { frontmatterLength } from "./markdown";

export type LiveSpec =
  | { kind: "hide"; from: number; to: number }
  | { kind: "line"; from: number; cls: string }
  | { kind: "mark"; from: number; to: number; cls: string }
  | { kind: "bullet"; from: number; to: number }
  | { kind: "task"; from: number; to: number; checked: boolean };
/** Pure: decoration specs for [from,to) given the tree, doc and the 1-based lines holding a selection. */
export function liveSpecs(tree: Tree, doc: Text, activeLines: ReadonlySet<number>, from = 0, to = doc.length): LiveSpec[];
/** Pure: target of the wikilink whose [[…]] span (inclusive) contains `col`, else null. */
export function wikilinkAtCursor(lineText: string, col: number): string | null;
export interface LiveOptions { onLinkClick: (target: string) => void; taskLabel: string; fmLabel: string }
export function liveExtension(opts: LiveOptions): Extension;   // [frontmatterField, decorationsPlugin]
```
Lezer node names relied on (`node_modules/@lezer/markdown/dist/index.js:36-90`): `Document ATXHeading1..6 SetextHeading1..2 HeaderMark Paragraph Blockquote QuoteMark BulletList OrderedList ListItem ListMark Emphasis StrongEmphasis EmphasisMark InlineCode CodeMark Link LinkMark URL LinkTitle Image FencedCode CodeBlock HTMLBlock` and GFM `Task TaskMarker Strikethrough StrikethroughMark`. **GFM nodes exist only with `markdown({ base: markdownLanguage })`** (`markdownLanguage` exported, lang-markdown d.ts:15; the current `markdown()` at Editor.tsx:61 defaults to `commonmarkLanguage`).
`liveSpecs`: `fmEnd = frontmatterLength(doc.sliceString(0, Math.min(doc.length, 32768)))` (`// ponytail: 32 KB frontmatter cap`); `tree.iterate({from,to,enter(n)})`: `n.from < fmEnd` → descend only `Document`; `FencedCode`/`CodeBlock` → `line live-code` per line, skip children; `Image`/`HTMLBlock` → skip; `/^(?:ATX|Setext)Heading([1-6])$/` → `line live-h{n}`; `Blockquote` → `line live-quote` per line; `StrongEmphasis`/`Emphasis`/`InlineCode`/`Strikethrough` → `mark live-strong|live-em|live-code-inline|live-strike`; `Link`: wikilink when `[` precedes and `]` follows and `matchWikilinkAt(line.text, n.from-1-line.from)` ends at `n.to+1` → `mark live-wikilink` over the full `[[…]]`, and when inactive hide `[[`, `target|`, `]]`, skip children; else no `URL` child → skip (bare `[text]`); else `mark live-link` and when inactive hide `[` (`n.from..n.from+1`) and `](`…`)` as ONE range (from the `](` LinkMark's `from` to `n.to`), skip children. `ListMark` under `BulletList` inactive → `bullet`; `TaskMarker` inactive → `task` (`checked = text !== "[ ]"`); `HeaderMark`/`QuoteMark` inactive → `hide` extended by one when followed by a space; `EmphasisMark`/`CodeMark`/`StrikethroughMark` inactive → `hide`.
`liveExtension`: `frontmatterField = StateField.define<DecorationSet>` computing `Decoration.replace({ widget: new FmWidget(opts.fmLabel), block: true }).range(0, fmEnd - 1)` when `fmEnd > 0` (recomputed on `docChanged` — P3's `patchProps` replaces `[0,end)`, which would drop a `foldEffect` fold; a StateField survives it); `provide: f => EditorView.decorations.from(f)`. Decorations plugin = `ViewPlugin.define(view => ({ decorations: build(view), update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = build(u.view) } }), { decorations: v => v.decorations, eventHandlers: { mousedown, keydown } })`; `build` walks `view.visibleRanges` → `liveSpecs` → `Decoration.set(ranges, true)` (all replaces intra-line, so a ViewPlugin is allowed). `TaskWidget(checked, label)` → `input[type=checkbox].live-task` with `aria-label`, `ignoreEvent() { return false }`; `BULLET = Decoration.replace({ widget: GlyphWidget("•") })`. `mousedown`: target `input.live-task` → `pos = view.posAtDOM(target)`, if `/^\[[ xX]\]$/.test(sliceDoc(pos,pos+3))` dispatch the toggle, return true; else Mod-click → `wikilinkAtCursor(line.text, pos - line.from)` → `opts.onLinkClick`, return true. `keydown` on the checkbox: Space/Enter → same toggle.
```ts
// src/components/Editor.tsx
export interface EditorProps { docKey; initialValue; t: Strings; live: boolean; viewRef?; onChange?; onSave?; onLinkClick?: (target: string) => void }
// markdown({ base: markdownLanguage }); const liveComp = useRef(new Compartment()).current;   // Compartment d.ts:719 — identity token, reusable across states
// create the view with liveComp.of([]); ONE configuration path:
// useEffect(() => { const v = viewRef?.current ?? localViewRef.current; if (!v) return;
//   v.dispatch({ effects: liveComp.reconfigure(live ? liveExtension(liveOpts) : []) }); }, [live, docKey]);
// liveOpts = { onLinkClick: (x) => onLinkClickRef.current?.(x), taskLabel: t.rd_task_toggle ?? "Toggle task", fmLabel: t.rd_frontmatter_hidden ?? "Frontmatter hidden — edit in Properties or Source" }
// container className={live ? "myco-editor live" : "myco-editor"}

// src/stores/uiStore.ts
export type EditorMode = "live" | "source" | "split" | "preview";
editorMode: EditorMode;                     // default "live"; merge: sanitize to "live" when not one of the four
setEditorMode: (mode: EditorMode) => void;

// src/pages/PageReader.tsx
// replace useState mode (176) with useUIStore editorMode/setEditorMode; hoist the inline onLinkClick (457-479) to
// function handleLinkClick(target: string): void  (unchanged body) → <Viewer onLinkClick={handleLinkClick}> and
// <Editor live={mode === "live"} t={t} onLinkClick={handleLinkClick} …>; Editor when mode !== "preview", Viewer when split|preview.
```

## IPC additions
None.

## i18n keys (interface after `rd_meta` l.798; en 2255; ko 3715; ja 4998; `hw_sc_*` beside l.144)
| key | en | ko | ja |
|---|---|---|---|
| rd_live | Live | 실시간 | ライブ |
| rd_task_toggle | Toggle task | 할 일 완료 전환 | タスクの完了を切り替え |
| rd_frontmatter_hidden | Frontmatter hidden — edit in Properties or Source | frontmatter 숨김 — 속성 패널 또는 소스에서 편집 | frontmatter は非表示 — プロパティまたはソースで編集 |
| hw_sc_live_link | Open the wikilink under the pointer (Live editor) | 포인터 아래 위키링크 열기 (실시간 편집기) | ポインター下のウィキリンクを開く（ライブ編集） |

## Tests — `src/lib/editorLive.test.ts`
Node env (`@codemirror/lang-markdown`, `@codemirror/state`, `@codemirror/view` import without DOM; parse with `markdownLanguage.parser.parse(src)`, `Text.of(src.split("\n"))`; `hidden(specs)` = hide slices). (1) `# Title` → `live-h1` + hidden `"# "`; setext `T\n===` → `live-h1` on the text line, `===` hidden. (2) `**b** *e* \`c\` ~~s~~` → the 8 marks hidden, 4 marks with exact ranges. (3) `[link](http://x.y "t")` → `live-link`, hidden exactly `["[", "](http://x.y \"t\")"]`. (4) `[[Wiki Page|alias]]` → one `live-wikilink`, hidden `[[`, `Wiki Page|`, `]]`; `[[Plain]]` hides `[[`/`]]`; `[bare]` → no specs; `[[a]b]]` → no specs. (5) `- item` → bullet; `- [ ] t` → task false; `- [X] d` → true; `1. one` → no bullet. (6) `> q\n> m` → `live-quote` ×2, `"> "` hidden ×2. (7) Active line reveal: no hides/tasks inside the active line, others intact. (8) Frontmatter: `---\ntitle: x\ntags: [a]\n---\nbody` → no spec inside `[0, fmEnd)` (the inner `[a]` Link and the Setext H2 the parser sees are skipped). (9) Fenced block with `**no**` → `live-code` lines, no hides; `![img](a.png)` → nothing. (10) Range window `liveSpecs(tree, doc, new Set(), 0, 40)` → specs start < 40. (11) `wikilinkAtCursor("see [[Foo|bar]] and [[Baz]]", 6) === "Foo"`, col 20 → `"Baz"`, col 0 → null, closing `]]` inclusive → `"Foo"`.

## Edge cases & failure handling
Incomplete parse on huge docs → the `syntaxTree` identity trigger re-decorates when parsing finishes; only `visibleRanges` walked. Multi-cursor → every selected line revealed. Stale checkbox → regex guard no-op. Task toggle → `updateListener` → `scheduleSave`. raw/: only the existing `saveFile` path writes (Rust refuses raw). Nested emphasis in link text → non-overlapping replaces. CRLF: Lezer treats `\r\n` as a break; `FRONTMATTER_RE` handles it. Doc that is only frontmatter → widget range `[0, fmEnd-1]`, nothing else. Invalid persisted mode → sanitized to `live`. Language switch → labels refresh on the next file open. No async data (idle/success only).

## Estimated diff size (lines) and risk
≈ +380 / −25: editorLive.ts 180, test 120, Editor +30/−3, PageReader +15/−20, uiStore +8, styles +40, i18n +16, HelpWidget +1, package.json +2, READMEs 3. Risk: low-medium — new CM decoration code is the only novel surface; the GFM base change alters tree shape only (no highlighting wired).

## Follow-ups explicitly excluded
Mod-click on external links (`ipc.openExternal` plumbing); inline images/tables/HR in Live; `Mod-E` mode toggle; syntax highlighting in Source; `editorMode` in the portable bundle; ordered-list renumbering; Live in the split pane's second route; dropping Split.

---

# P4 Portability — saved Views in the vault, note templates, local daily note

## Goal (2 lines) & how it reduces "hard to manage" vs Obsidian/Notion
Saved Views move to `<vault>/.myco/views/*.json` and note templates live in `<vault>/templates/*.md` (Obsidian keeps `.obsidian/` and a templates folder the same way), so both survive reinstalls and follow the vault; the daily-note button opens today's local day. Also fixes Save view, which is dead in the Tauri build today.

## UX behavior
**(a) Saved Views (`src/pages/PageViews.tsx`).** Entering Views: chips slot empty while loading, then the vault's views (name-sorted by Rust). Error → `<p role="alert" className="muted">{vw_load_error}</p>` in the slot. Empty → no row. "Save view" → `promptText` (dialogStore.ts:39); name = `sanitizeNoteName(raw)?.slice(0, 60)`; the file stem IS the view name and id; an existing name asks `confirmAction` `vw_overwrite_q` first. Chip × → `delete_view`. Save/delete failure → `vw_io_error` alert under the chips. No localStorage migration: `window.prompt` never worked in the Tauri build, so no real vault ever wrote `myco.queryViews.v1` (`loadViews/saveViews` stay untouched for settingsBundle.ts:136/366).
**(b) Templates.** Context menu gains `tpl_new_from` directly under the "New folder" `<li>` (Sidebar.tsx:482, before the separator); ⌘K gains the same action beside "New note" (CommandBar.tsx:119-125). Both call `newNoteFromTemplate(t, dir?)`; the menu passes `parentDir()`, the palette nothing → `wiki/`. A `pickDialog` lists `<vault>/templates/*.md` as full-width `<button className="myco-modal__btn">`s (label = stem; `.myco-modal__btn` already has hover/focus-visible, styles.css:2314-2317); message `tpl_pick_msg`; Tab cycles buttons + Cancel, Enter picks, Esc cancels, focus starts on the first button and returns to the opener (DialogHost restores focus, DialogHost.tsx:31-33/44-46). Empty state: `tpl_empty` + primary `tpl_create_starters` → disabled `tpl_creating` → `create_folder templates` + `write_file` ×2 (localized starters) → `refreshTree()` → the same dialog re-renders as the list; failure → `role="alert"` `tpl_create_error`, button re-enabled. After a pick: the existing "New note" prompt for the title → `createNoteFromTemplate`. Existing stem → opens it, template not applied (same rule as ⌘N). A `raw/` context dir is redirected to `wiki/`. Failure → `confirmAction` used as an alert with `tpl_note_error`.
**(c) Daily note** — Sidebar.tsx:517 uses `today()` (taskLine.ts:192). No UX change.

## Files to touch (existing) / Files to create
Touch: `src/pages/PageViews.tsx`, `src/lib/queryViews.ts` (+ `.test.ts`), `src/components/Sidebar.tsx` (menu item after l.482; DailyNoteButton 517-526), `src/components/CommandBar.tsx`, `src/stores/dialogStore.ts`, `src/components/DialogHost.tsx` (l.40 focus fallback; hide the primary button for `pick`, 147-156), `src/lib/i18n.ts`, `src/lib/ipc.ts` (after 1197), `src/lib/devMock.ts` (after 2732; `templates/` children in `fileTree()` near `roadmapChildren` l.1123), `src/lib/taskLine.test.ts` (`describe("today")`), `src-tauri/src/commands.rs` (1672-1734 generalized + 3 commands + tests), `src-tauri/src/vault.rs` (`NON_WIKI_DIRS` 752-762), `src-tauri/src/index.rs` (`is_staging_dir` 89-95), `src-tauri/src/lib.rs` (after 227), `app/README.md` Writing table (40-49), root `README.md` Portable settings (259-264) + `README-ko.md` 설정 이동 (249-253): saved views now travel with the vault.
Create: `src/lib/templates.ts` + `.test.ts`, `src/components/TemplatePicker.tsx`.

## New/changed functions & types
```ts
// src/stores/dialogStore.ts
export type DialogKind = "prompt" | "confirm" | "pick";      // l.8
/** List-style dialog: `body` renders the choices and calls useDialogStore.getState().close(value) itself; no primary button. */
export function pickDialog(opts: { title: string; message?: string; body: ReactNode }): Promise<string | null>;
// DialogHost.tsx l.40: (primaryRef.current ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();  (FOCUSABLE: l.13)
//                 147-156: render the primary <button> only when request.kind !== "pick"

// src/lib/templates.ts
export interface TemplateVars { date: string; time: string; title: string }
export function applyTemplate(raw: string, vars: TemplateVars): string;        // /\{\{\s*(date|time|title)\s*\}\}/g; unknown {{x}} untouched
export function localTime(now: Date = new Date()): string;                    // HH:MM local
export function templateFiles(tree: FileNode[]): FileNode[];                   // .md files directly under top-level `templates/`
/** A raw/ context dir falls back to wiki/ — templates never write into raw/. */
export function templateTargetDir(root: string, dir: string | undefined): string | undefined;
export function starterTemplates(t: Strings): { name: string; content: string }[];
//   note:    `---\ntitle: "{{title}}"\ntype: concept\ntags: []\ncreated: "{{date}}"\nconfidence: medium\nstatus: active\n---\n\n# {{title}}\n\n` + t.tpl_starter_note_body
//   meeting: same with `type: source-summary`, `tags: [meeting]` + t.tpl_starter_meeting_body   (quoted placeholders: `{{x}}` is a YAML flow mapping)
//   names: `${t.tpl_starter_note ?? "note"}.md`, `${t.tpl_starter_meeting ?? "meeting"}.md`
export async function createStarterTemplates(t: Strings): Promise<void>;       // ipc.createFolder(root,"templates").catch(()=>undefined); ipc.writeFile ×2; refreshTree()
export async function createNoteFromTemplate(templatePath: string, rawName: string, dir?: string): Promise<string | null>;
//   name = sanitizeNoteName(rawName) (newNote.ts:17) ?? return null
//   existing = store.resolveWikilink(name) → setRoute(`page:${existing}`), return existing        // never overwrite
//   tpl = await ipc.readFile(templatePath)                                                          // throws → caller alert
//   path = await store.openWikilink(name, templateTargetDir(root, dir)); if (!path) return null     // creates + seeds the stub
//   await ipc.writeFile(path, applyTemplate(tpl.raw, { date: today(), time: localTime(), title: name }))  // ipc, not saveFile: saveFile swallows into vaultStore.error
//   void store.refreshLinkGraph(); setRoute(`page:${path}`); return path

// src/components/TemplatePicker.tsx
export async function newNoteFromTemplate(t: Strings, dir?: string): Promise<void>;
function TemplatePickerBody({ t }: { t: Strings }): JSX.Element;  // templates = useVaultStore(s => templateFiles(s.fileTree)); local busy/err; buttons call close(path)

// src/lib/queryViews.ts
export function viewRel(name: string): string;                          // `.myco/views/${name}.json` (board.ts:91-93 idiom)
/** Stem is authoritative for id AND name; tolerant of hand-written files: object with object `filter`, sort ∈ SORTS else "name", desc === true. */
export function parseSavedView(raw: string, stem: string): SavedView | null;
export function saveVaultView(v: SavedView): Promise<void>;             // ipc.saveView(v.name, JSON.stringify(v, null, 2))
export async function loadVaultViews(vaultRoot: string): Promise<SavedView[]>;
//   names = await ipc.listViews(); readFile(`${vaultRoot}/${viewRel(n)}`) each (vault::read_file has no .md restriction, vault.rs:615-656); parse; drop nulls
```
PageViews: `views` starts `[]`; `viewsState: "loading" | "ready" | "error"`; effect on `vaultPath` with a cancelled flag; `saveCurrent` async as above; `removeView(v)`; `ioError: string | null`. Header comment l.5 → `(.myco/views/*.json)`.
Sidebar: `import { today } from "../lib/taskLine"`; DailyNoteButton `const day = today();` (rename the local to avoid shadowing). CommandBar: `{ type: "action", label: t.tpl_new_from ?? "New note from template…", run: () => void newNoteFromTemplate(t) }`.
```rust
// src-tauri/src/commands.rs — replaces dashboard_path/save/list/delete bodies (1675-1732); command signatures unchanged
/// A JSON document under `.myco/<kind>/`. Names come from the user, so they are validated as bare filenames.
fn myco_json_path(root: &Path, kind: &str, name: &str) -> Result<PathBuf, String>
    // trim; chars().count() 1..=60 (was bytes — 21+ char Korean names were rejected); reject '/', '\\', "..", leading '.'
fn save_myco_json(root: &Path, kind: &str, name: &str, content: &str) -> Result<(), String>   // create_dir_all(parent) + vault::write_file
fn list_myco_json(root: &Path, kind: &str) -> Vec<String>                                       // sorted .json stems, missing dir → []
fn delete_myco_json(root: &Path, kind: &str, name: &str) -> Result<(), String>                 // std::fs::remove_file (not trash, as today)
#[tauri::command] pub fn save_view(state: tauri::State<VaultRoot>, name: String, content: String) -> Result<(), String>
#[tauri::command] pub fn list_views(state: tauri::State<VaultRoot>) -> Result<Vec<String>, String>
#[tauri::command] pub fn delete_view(state: tauri::State<VaultRoot>, name: String) -> Result<(), String>
// vault.rs NON_WIKI_DIRS += "templates" (no stub seeded for a note created inside templates/)
// index.rs is_staging_dir: `Some("_inbox") | Some("sessions") | Some("templates")` — scaffolds are not knowledge: keeps `{{title}}` nodes out of the graph/Tags/lint; list_files (sidebar) still shows the folder
```
Decision: parallel thin commands, not a `kind` IPC param — no user-controlled kind string and zero change to board.ts call sites.

## IPC additions
| command | params | return | Rust validation |
|---|---|---|---|
| `save_view` | `name, content` | `()` | `require_root`; `myco_json_path` rules; creates `.myco/views/`; atomic write |
| `list_views` | — | `Vec<String>` | `require_root`; missing dir → `[]` |
| `delete_view` | `name` | `()` | same name rules; error surfaced |

`ipc.ts`: `saveView: (name: string, content: string) => invoke<void>("save_view", { name, content })`, `listViews: () => invoke<string[]>("list_views")`, `deleteView: (name: string) => invoke<void>("delete_view", { name })`. `lib.rs`: three entries after `commands::delete_dashboard,` (l.227). `devMock.ts`: `save_view` → `mockNotes.set(\`${VAULT}/.myco/views/${name}.json\`, content)` (read_file serves `mockNotes`), `list_views` → stems with that prefix, sorted; `delete_view` → `mockNotes.delete`; `templatesChildren` in `fileTree()`.

## i18n keys (optional; en / ko / ja)
| key | en | ko | ja |
|---|---|---|---|
| vw_load_error | Saved views could not be read from .myco/views/. | 저장된 뷰를 .myco/views/에서 읽지 못했습니다. | 保存したビューを .myco/views/ から読み込めませんでした。 |
| vw_io_error | Could not update saved views: {err} | 저장된 뷰를 갱신하지 못했습니다: {err} | 保存したビューを更新できませんでした: {err} |
| vw_overwrite_q | Replace the saved view “{name}”? | 저장된 뷰 “{name}”을(를) 덮어쓸까요? | 保存したビュー「{name}」を置き換えますか？ |
| tpl_new_from | New note from template… | 템플릿으로 새 노트… | テンプレートから新規ノート… |
| tpl_pick_title | Choose a template | 템플릿 선택 | テンプレートを選択 |
| tpl_pick_msg | Templates are plain .md files in templates/ in your vault. {{date}}, {{time}} and {{title}} are filled in. | 템플릿은 볼트의 templates/ 폴더에 있는 .md 파일입니다. {{date}}, {{time}}, {{title}}이 채워집니다. | テンプレートはボールトの templates/ にある .md ファイルです。{{date}}、{{time}}、{{title}} が置き換えられます。 |
| tpl_empty | No templates yet. Create templates/ with two starters (note, meeting) you can edit. | 아직 템플릿이 없습니다. templates/ 폴더와 수정 가능한 시작 템플릿 2개(노트, 회의록)를 만듭니다. | テンプレートはまだありません。編集できる2つのスターター（ノート、会議メモ）と templates/ を作成します。 |
| tpl_create_starters | Create templates folder | 템플릿 폴더 만들기 | テンプレートフォルダを作成 |
| tpl_creating | Creating… | 만드는 중… | 作成中… |
| tpl_create_error | Could not create templates: {err} | 템플릿을 만들지 못했습니다: {err} | テンプレートを作成できませんでした: {err} |
| tpl_note_error | Could not create the note from the template: {err} | 템플릿으로 노트를 만들지 못했습니다: {err} | テンプレートからノートを作成できませんでした: {err} |
| tpl_starter_note | note | 노트 | ノート |
| tpl_starter_meeting | meeting | 회의록 | 会議メモ |
| tpl_starter_note_body | `## Summary\n\n## Details\n\n## Sources\n` | `## 요약\n\n## 내용\n\n## 출처\n` | `## 要約\n\n## 詳細\n\n## 出典\n` |
| tpl_starter_meeting_body | `> {{date}} {{time}}\n\n## Attendees\n\n## Agenda\n\n## Notes\n\n## Action items\n\n- [ ] \n` | `> {{date}} {{time}}\n\n## 참석자\n\n## 안건\n\n## 논의 내용\n\n## 액션 아이템\n\n- [ ] \n` | `> {{date}} {{time}}\n\n## 参加者\n\n## アジェンダ\n\n## メモ\n\n## アクションアイテム\n\n- [ ] \n` |

Reused: `sb_new_note`, `sb_new_note_msg`, `sb_new_note_ph`, `vw_save`, `vw_save_prompt`, `ui_close`, `dlg_cancel`.

## Tests
`src/lib/templates.test.ts`: `applyTemplate` substitutes all three, repeats, `{{ date }}` with spaces, leaves `{{foo}}`, `""`→`""`; `localTime(new Date(2026,0,1,9,5))` → `"09:05"`; `templateFiles` (top-level files only, nested dirs skipped, missing → `[]`, a file named templates → `[]`); `templateTargetDir("/v", "/v/raw/x")` and `"/v/raw"` → `undefined`, `"/v/wiki/a"` → itself, `undefined` → `undefined`; `starterTemplates(STRINGS[lang])` for en/ko/ja: 2 entries ending `.md`, each has `{{title}}` and `{{date}}`, `applyTemplate(content, vars)` contains no `{{`, and `parseFrontmatter(applyTemplate(...))` (P3) yields `title` = vars.title and `status` = `"active"`.
`src/lib/queryViews.test.ts` (append): `parseSavedView` stem wins over in-file id/name; missing `filter` → null; invalid JSON → null; unknown sort → `"name"`; non-boolean `desc` → false; `viewRel("x")`.
`src/lib/taskLine.test.ts` (`describe("today")`): set `process.env.TZ = "Asia/Seoul"` in a try/finally; `d = new Date(2026, 2, 1, 0, 5)`; `d.toISOString().slice(0,10) === "2026-02-28"` (what Sidebar used to compute) and `today(d) === "2026-03-01"`. (A runtime `TZ` assignment reaches `Date` in vitest 2.1.9's `forks` pool on Node 24 — confirmed by the P4 draft's scratch run; if it does not on CI, construct the date with an explicit offset instead.)
Rust `commands.rs mod tests` (tempdir): `myco_json_path_validates_bare_names` (rejects "", 61 chars, `a/b`, `a\b`, `..`, `.hidden`; accepts a 21-char Korean name → `<root>/.myco/views/<name>.json`); `myco_json_round_trip_is_kind_scoped` (save "b","a" under views; list views == ["a","b"]; list dashboards == []; delete "a" → ["b"]; delete again → Err). `index.rs mod tests`: `collect_files_skips_top_level_templates`. `vault.rs`: `should_seed_frontmatter` false under `templates/`.
Browser (`?mock=1`): Views save → chip appears and survives a route change; overwrite asks; sidebar right-click → picker empty state → create → two entries → pick → title → note opens with the substituted header.

## Edge cases & failure handling
View name invalid after sanitize → no-op (matches `promptNewNote`); Rust is the backstop, its text lands in `vw_io_error`. Corrupt/hand-edited view file → skipped; `{"filter":{}}` loads as a view named by its stem. `templates/` with only non-`.md` files → empty state; starters never overwrite (the button exists only when nothing is listed). Template read fails between listing and pick → alert, nothing created. `openWikilink` null (no vault/race) → return null. raw/ never written: `templateTargetDir` redirects, and `write_file` would refuse an existing raw file anyway. Templates appear in the sidebar tree and ⌘K pages, not in the graph/Views/Tags. `.myco-menu` CSS is P2's; the new item inherits it (P2 lands after P4 — the item is usable but unstyled for one slice, as the menu already is today).

## Estimated diff size (lines) and risk
≈ 520: templates.ts 75, test 65, TemplatePicker 80, queryViews +50, test +40, PageViews ±60, Sidebar +12, CommandBar +6, dialogStore/DialogHost +14, ipc +7, lib.rs +3, devMock +25, commands.rs ±80 incl. tests, vault.rs/index.rs +2 (+15 tests), taskLine.test +12, i18n ~64. Risk: low-medium — the dashboards refactor keeps signatures and is covered by the new Rust tests; the DialogHost change affects all dialogs but only when there is no primary button.

## Follow-ups explicitly excluded
`templates/daily.md` driving the daily-note button; `{{date:FORMAT}}`/cursor placeholders; other UTC-day sites (fsrs.ts:45, maps.ts:183, budget.ts:95, Rust `registry::today_utc()` seeding `created:`); dropping `queryViews` from the settings bundle; a filter input in the picker for very large template sets.

---

# P1 Editor basics — slash blocks, tag completion, find, image paste, outline

## Goal (2 lines) & how it reduces "hard to manage" vs Obsidian/Notion
Give the editor the five things every Obsidian/Notion user reaches for without thinking: `/` blocks, tag completion, ⌘F find/replace, paste an image, an always-visible outline — plus the `[[Note#H]]` bug fix. Three commits, each independently shippable and gated: **P1a** completions + find (TS only), **P1b** images (Rust + asset protocol), **P1c** outline.

## UX behavior
**P1a Slash menu** — `/` at line start or after whitespace opens the completion tooltip with 11 items; typing filters by the English keyword OR the localized description (`/h2`, `/표`, `/할 일` all work); Enter/Tab applies (the `/word` is replaced), Esc or a space closes. Items (label → snippet, `${}` = final caret): `h1` `# ${}` · `h2` `## ${}` · `h3` `### ${}` · `bullet` `- ${}` · `numbered` `1. ${}` · `todo` `- [ ] ${}` · `code` `` ```${lang}\n${}\n``` `` · `quote` `> ${}` · `table` `| ${Column} | Column |\n| --- | --- |\n| ${} |  |` · `divider` `---\n${}` · `date` `<today()>`. (No `link` item — `[[` already opens completion.)
**P1a Tag completion** — inside the frontmatter only, on `tags: a, b|`, `tags: [x, y|` (last item) and `  - fo|` under `tags:` → vault tags from `tagCandidates`, applied as the bare tag. Decision: no body `#tag` trigger — `index.rs::extract_tags` reads frontmatter only, so a body completion would write tags Tags/Views/graph never see; body-tag indexing is a follow-up and the trigger comes back with it.
**P1a Find/replace** — ⌘F opens CodeMirror's search panel at the top of the editor (⌘G/⇧⌘G next/prev, Esc closes, ⌘⌥G go to line — `searchKeymap` defaults); strings localized through `EditorState.phrases`; colours through `EditorView.theme` tokens so the panel and the completion tooltip are dark on the dark theme. Editor-scoped: in Preview mode ⌘F does nothing (documented).
**P1a fix** — clicking `[[Note#Heading]]` opens `Note` (no `Note#Heading.md` created); `[[Note#H]]` indexes as `Note` in the graph.
**P1b Images** — paste an image → saved to `<vault>/assets/YYYYMMDD-HHMMSS.<ext>` (local time; `-2`, `-3` on collision), `![](assets/…)` inserted with the caret inside `[]`. Unsupported type or IPC failure → `role="alert"` line under the reader header via `onError`. Preview renders vault images through Tauri's asset protocol; Obsidian's `![[shot.png]]` renders as `assets/shot.png`. The Obsidian scaffold's `attachmentFolderPath` becomes `assets` (was `raw/assets`, vault.rs:827 — never a valid myco write target).
**P1c Outline** — 180px sticky `<aside className="reader-side">` right of the editor/preview at ≥900px, toggled by `<button className="btn btn-ghost outline-toggle" aria-pressed aria-label={t.ol_toggle} title>` with `<Icon name="columns"/>` next to `.segmented`; state `uiStore.outlineOpen` (default true). Headings as indented real `<button>`s; click/Enter scrolls the editor (caret on the line + scrolled to top) and/or the preview (`data-line` element) — whichever panes the current `editorMode` shows. Empty → `ol_empty`. <900px hidden by CSS.

## Files to touch (existing) / Files to create
P1a touch: `package.json` + `package-lock.json` (`"@codemirror/search": "6.7.0"`, `npm install`), `src/components/Editor.tsx`, `src/stores/vaultStore.ts` (278-300), `src-tauri/src/parser.rs` (l.21), `src/lib/i18n.ts`. Create: `src/lib/editorCompletions.ts` + `.test.ts`.
P1b touch: `src/lib/markdown.ts`, `src/components/Viewer.tsx`, `src/components/Editor.tsx` (paste), `src/pages/PageReader.tsx` (error line, Viewer props), `src/lib/ipc.ts`, `src/lib/devMock.ts`, `src-tauri/src/commands.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml` + `Cargo.lock` (feature `protocol-asset`), `src-tauri/tauri.conf.json`, i18n. Create: `src/lib/assets.ts` + `.test.ts`.
P1c touch: `src/lib/markdown.ts` (`heading_open`), `src/pages/PageReader.tsx`, `src/stores/uiStore.ts`, `src/components/Editor.tsx` (`scrollEditorToLine` export), `src/styles.css`, i18n. Create: `src/lib/outline.ts` + `.test.ts`, `src/components/OutlinePanel.tsx`.
Docs: `app/README.md` Writing table (40-49) rows for `/` blocks, ⌘F, image paste, Outline; root `README.md` 249-252 / `README-ko.md` 239-242 Reader paragraph.

## New/changed functions & types
```ts
// src/lib/editorCompletions.ts (pure, no CM imports)
export interface TriggerMatch { from: number; query: string }   // from = offset in the passed text where the query starts
/** `prefix` = doc text up to the cursor. In-frontmatter iff prefix starts with a `---` fence line and frontmatterLength(prefix) === 0 (not yet closed). Matches `tags: a, b|`, `tags: [x, y|`, `  - fo|` under `tags:`; else null. */
export function tagQueryAt(prefix: string): TriggerMatch | null;
/** `/word` at line start or after whitespace: /(?:^|\s)\/(\S*)$/ — `9/2`, `a/b`, `http://` never match. `from` = the `/`. */
export function slashQueryAt(lineBefore: string): TriggerMatch | null;
export interface SlashItem { label: string; detail: string; template: string }
export function slashItems(t: Strings, now: Date = new Date()): SlashItem[];      // 11 items; `date` = today(now) (taskLine.ts:192)
/** label.startsWith(q) || normalizeQuery(detail).includes(normalizeQuery(q)) (settingsSearch.ts) */
export function filterSlash(items: SlashItem[], query: string): SlashItem[];

// src/components/Editor.tsx — additions to EditorState.create (44-79)
//   search({ top: true }) (search d.ts:238), EditorState.phrases.of(cmPhrases(tRef.current)) (state d.ts:1241),
//   ...searchKeymap after the Mod-s binding (d.ts:394), autocompletion({ override: [slashCompletion, wikilinkCompletion, tagCompletion] }),
//   EditorView.domEventHandlers({ paste })
// EditorView.theme gains: ".cm-panels": { background: "var(--bg-soft)", color: "var(--ink)", borderColor: "var(--line)" },
//   ".cm-textfield"/".cm-button": bg-elev/line/ink, ".cm-tooltip": bg-elev + line + shadow-pop, ".cm-tooltip-autocomplete ul li[aria-selected]": bg-active,
//   ".cm-searchMatch": accent-soft, ".cm-searchMatch-selected": bg-active
function cmPhrases(t: Strings): Record<string, string>;   // 18 CM phrase keys → t.cm_* ?? English
function slashCompletion(ctx: CompletionContext): CompletionResult | null;
//   { from: match.from, filter: false, options: filterSlash(items, q).map(i => ({ label: i.label, detail: i.detail, apply: (view, c, from, to) => snippet(i.template)(view, c, from, to) })) }
//   — `filter:false` + no validFor: the source re-runs per keystroke (11 items); snippet: autocomplete d.ts:476
function tagCompletion(ctx: CompletionContext): CompletionResult | null;  // tagQueryAt(ctx.state.doc.sliceString(0, ctx.pos)) → tagCandidates(adjacency?.tags ?? {}, query)
export interface EditorProps { …; onError?: (message: string) => void }    // P1b
async function insertImage(view: EditorView, file: File): Promise<void>;   // P1b paste path
/** Put the caret on 1-based `line1` (clamped), scroll it to the top and focus the editor (a selected line would be replaced by the next keystroke). */
export function scrollEditorToLine(view: EditorView, line1: number): void; // P1c
```
Paste: `files = Array.from(e.clipboardData?.files ?? []).filter(f => imageExtFor(f.type, f.name))`; none → `return false` (CM's text paste proceeds); else `preventDefault`, for each: `rel = await ipc.writeAsset(assetFileName(new Date(), ext), new Uint8Array(await f.arrayBuffer()))`, then `snippet("![${}](" + rel + ")")(view, null, head, head)`; failure → `onErrorRef.current?.((t.img_failed ?? "…").replace("{error}", String(err)))`; a clipboard holding both text and an image → the image wins (Obsidian/Notion behaviour). Unsupported files only → `onError(t.img_unsupported)`.
```ts
// src/lib/assets.ts
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"] as const;
export function assetFileName(now: Date, ext: string): string;                 // YYYYMMDD-HHMMSS.ext, local time
export function imageExtFor(mime: string, name: string): string | null;         // image/png→png, image/jpeg→jpg, gif, webp; else allow-listed name ext; else null
/** Absolute path for a markdown image src or null to leave it alone: scheme-prefixed → null; `./x`/`../x` relative to noteDir; `/x` and bare `x` relative to vaultRoot; `%xx` decoded. */
export function resolveImageSrc(src: string, vaultRoot: string, noteDir: string): string | null;

// src/lib/markdown.ts
export interface RenderEnv { vaultRoot?: string; noteDir?: string; toUrl?: (absPath: string) => string }
// image rule wraps markdown-it's default (renderer.mjs:77): rewrite `src` via resolveImageSrc + env.toUrl when both vaultRoot and toUrl are present, then delegate.
// embedRule inserted `before("image", "embed", …)`: at `![[`, matchWikilinkAt(src, pos+1) whose target ends in an IMAGE_EXTS extension → push an `image` token
//   (src `assets/<target>`, alt = display, children = []) and skip to match.end; otherwise return false (falls through to image/text — `![[note]]` unchanged).
// heading_open rule (P1c): attrSet("data-line", String(token.map[0])) then self.renderToken.
// render(src, env?) keeps working with no env (tests, Ask previews).

// src/components/Viewer.tsx
export interface ViewerProps { content: string; vaultRoot?: string; notePath?: string; onLinkClick?: (target: string) => void }
// useMemo(() => markdownRenderer.render(stripFrontmatter(content), { vaultRoot, noteDir: notePath?.replace(/[\\/][^\\/]+$/, ""), toUrl: convertFileSrc }), [...])
// convertFileSrc from "@tauri-apps/api/core" (core.d.ts:158)

// src/lib/outline.ts (P1c)
export interface OutlineHeading { level: 1|2|3|4|5|6; text: string; line: number }   // line = 0-based line in the BODY
/** markdownRenderer.parse(body, {}) → heading_open tokens (ATX + setext; fences skipped for free); text = inline children of type text/code_inline/wikilink joined. */
export function extractHeadings(body: string): OutlineHeading[];
/** Lines removed by stripFrontmatter: count of "\n" in raw.slice(0, frontmatterLength(raw)). Add to `line` for the editor line. */
export function bodyLineOffset(raw: string): number;

// src/components/OutlinePanel.tsx (P1c)
export default function OutlinePanel({ t, headings, onSelect }: { t: Strings; headings: OutlineHeading[]; onSelect: (h: OutlineHeading) => void }): JSX.Element;
// <nav className="outline" aria-label={t.ol_title}> · <ul> of <li><button className="outline__item" style={{ paddingLeft: (level-1)*10 + 8 }}> · empty → <p className="muted">{ol_empty}</p> · empty text → ol_untitled

// src/pages/PageReader.tsx (P1b/P1c)
// const [editorError, setEditorError] = useState<string | null>(null); {editorError ? <p role="alert" className="muted" style={{fontSize:12.5}}>{editorError}</p> : null} under the header
// const previewRef = useRef<HTMLDivElement|null>(null) on the `.prose` wrapper; headings = useMemo(() => extractHeadings(stripFrontmatter(draft)), [draft]); lineOffset = useMemo(() => bodyLineOffset(draft), [draft])
// function scrollToHeading(h): if (editorViewRef.current) scrollEditorToLine(view, h.line + 1 + lineOffset); previewRef.current?.querySelector(`[data-line="${h.line}"]`)?.scrollIntoView({ block: "start" })
// wrap the editor <section> in <div className={"reader-body" + (outlineOpen ? " reader-body--outline" : "")}> and append <aside className="reader-side"><OutlinePanel …/></aside> when open
// Editor gets t/viewRef/onError={setEditorError}; Viewer gets vaultRoot={currentVaultPath} notePath={path}

// src/stores/vaultStore.ts (P1a fix)
// resolveWikilink: findFileByStem(get().fileTree, target.split("#")[0].toLowerCase())
// openWikilink: const base = target.split("#")[0].trim(); if (!base) return null; use `base` for the created name
// src/stores/uiStore.ts (P1c): outlineOpen: boolean (default true); toggleOutline
```
```rust
// src-tauri/src/parser.rs:21
let target = raw.split('|').next().unwrap_or(raw);
let target = target.split('#').next().unwrap_or(target).trim();   // [[Note#H]] → Note; [[#H]] → empty → dropped at l.28

// src-tauri/src/vault.rs (P1b)
pub const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;
const ASSET_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// Write `bytes` as `<root>/assets/<name>`, creating `assets/`, suffixing `-2`, `-3`… on collision
/// (archive_inbox_source idiom, vault.rs:925-935). `name` is a bare `stem.ext`: validate_name (939-950) + allowlist + size cap.
/// Plain std::fs::write — a fresh unique file needs none of write_file's overwrite atomicity. Never touches raw/.
pub fn write_asset(root: &Path, name: &str, bytes: &[u8]) -> Result<String, String>;   // returns "assets/<final name>"
// scaffold_obsidian_vault (l.827): "{\"attachmentFolderPath\":\"assets\"}"

// src-tauri/src/commands.rs (P1b) — raw-body twin of read_raw_bytes (350-359)
#[tauri::command]
pub fn write_asset(state: tauri::State<VaultRoot>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let root = require_root(&state)?;
    let name = request.headers().get("x-myco-name").and_then(|v| v.to_str().ok()).ok_or("missing x-myco-name header")?;   // ipc/mod.rs:160
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected a raw body".into()) };            // ipc/mod.rs:59-63, 155
    vault::write_asset(&root, name, bytes)
}
// open_vault (239-244): use the existing `app: tauri::AppHandle` (drop its #[allow(unused_variables)]); after state.set(...):
//   if let Err(e) = app.asset_protocol_scope().allow_directory(&meta.path, true) { eprintln!("asset scope: {e}"); }
//   (tauri::Manager in scope; asset_protocol_scope: tauri-2.11.1 src/lib.rs:760-761 behind `protocol-asset`; allow_directory: src/scope/fs.rs:278)
// Cargo.toml:22 features += "protocol-asset"; tauri.conf.json app.security += "assetProtocol": { "enable": true } (scope extended at runtime; CSP already allows img-src asset: http://asset.localhost, l.28)
```

## IPC additions (P1b)
| command | params | returns | Rust validation |
|---|---|---|---|
| `write_asset` | raw body `Uint8Array`; header `x-myco-name: <stem>.<ext>` | `String` vault-relative (`assets/20260902-101010.png`) | `require_root`; body `InvokeBody::Raw`; header present + ASCII; `validate_name`; ext ∈ allowlist (case-insensitive); `len ≤ MAX_ASSET_BYTES`; collision suffix |

`ipc.ts`: `writeAsset: (name: string, bytes: Uint8Array) => invoke<string>("write_asset", bytes, { headers: { "x-myco-name": name } })` (`InvokeArgs` accepts `Uint8Array`, `InvokeOptions.headers`: core.d.ts:105-110, 127). `lib.rs`: `commands::write_asset,` beside `read_raw_bytes` (l.163). `devMock.ts`: `case "write_asset": return Promise.resolve("assets/20260101-000000.png");` and `convertFileSrc: (p: string) => p` on `__TAURI_INTERNALS__` in `installTauriMock` (2938-2952) so the preview does not throw under `?mock=1`.

## i18n keys (one `// Editor basics (P1)` block; all optional)
| key | en | ko | ja |
|---|---|---|---|
| cm_find | Find | 찾기 | 検索 |
| cm_replace_field | Replace | 바꾸기 | 置換 |
| cm_next | next | 다음 | 次 |
| cm_previous | previous | 이전 | 前 |
| cm_all | all | 모두 | すべて |
| cm_match_case | match case | 대소문자 구분 | 大文字小文字を区別 |
| cm_by_word | by word | 단어 단위 | 単語単位 |
| cm_regexp | regexp | 정규식 | 正規表現 |
| cm_replace | replace | 바꾸기 | 置換 |
| cm_replace_all | replace all | 모두 바꾸기 | すべて置換 |
| cm_close | close | 닫기 | 閉じる |
| cm_current_match | current match | 현재 일치 항목 | 現在の一致 |
| cm_replaced_matches | replaced $ matches | $개 항목을 바꿨습니다 | $件を置換しました |
| cm_replaced_on_line | replaced match on line $ | $번째 줄의 항목을 바꿨습니다 | $行目の一致を置換しました |
| cm_on_line | on line | 줄 | 行 |
| cm_goto_line | Go to line | 줄 이동 | 行へ移動 |
| cm_go | go | 이동 | 移動 |
| cm_completions | Completions | 자동 완성 | 補完 |
| sl_h1 | Heading 1 | 제목 1 | 見出し1 |
| sl_h2 | Heading 2 | 제목 2 | 見出し2 |
| sl_h3 | Heading 3 | 제목 3 | 見出し3 |
| sl_bullet | Bulleted list | 글머리 기호 목록 | 箇条書き |
| sl_numbered | Numbered list | 번호 목록 | 番号付きリスト |
| sl_todo | To-do | 할 일 | チェックボックス |
| sl_code | Code block | 코드 블록 | コードブロック |
| sl_quote | Quote | 인용 | 引用 |
| sl_table | Table | 표 | 表 |
| sl_divider | Divider | 구분선 | 区切り線 |
| sl_date | Today's date | 오늘 날짜 | 今日の日付 |
| ol_title | Outline | 개요 | アウトライン |
| ol_empty | No headings yet | 아직 제목이 없습니다 | 見出しはまだありません |
| ol_untitled | (untitled) | (제목 없음) | (無題) |
| ol_toggle | Show or hide the outline | 개요 표시/숨기기 | アウトラインの表示/非表示 |
| img_unsupported | Only PNG, JPEG, GIF and WebP images can be inserted | PNG, JPEG, GIF, WebP 이미지만 넣을 수 있습니다 | 挿入できるのはPNG・JPEG・GIF・WebP画像のみです |
| img_failed | Image could not be saved: {error} | 이미지를 저장하지 못했습니다: {error} | 画像を保存できませんでした: {error} |

CM phrase keys map 1:1 to the strings in `@codemirror/search/dist/index.js` (`Find`, `Replace`, `next`, `previous`, `all`, `match case`, `by word`, `regexp`, `replace`, `replace all`, `close`, `current match`, `replaced $ matches`, `replaced match on line $`, `on line`, `Go to line`, `go`) and `@codemirror/autocomplete` (`Completions`).

## Tests
`src/lib/editorCompletions.test.ts`: `tagQueryAt` — `---\ntags: a, b` → `"b"`; `---\ntags: [x, y` → `"y"`; `---\ntags:\n  - fo` → `"fo"`; `---\ntitle: t\n  - fo` → null; `---\na: 1\n---\nbody #ta` → null (closed block, no body trigger); `tags: a` without a leading fence → null. `slashQueryAt` — `/` → `""`; `  /tab` → `"tab"`; `a /x` → `"x"`; `9/2` → null; `http://x` → null; `/x ` → null. `slashItems` — 11 items, none labelled `link`; `date` template = `today(new Date(2026,0,5))` = `2026-01-05`. `filterSlash(slashItems(STRINGS.ko), "표")` → `[table]`; `"h"` → h1,h2,h3; `""` → all.
`src/lib/assets.test.ts`: `assetFileName(new Date(2026,8,2,9,5,7),"png")` → `20260902-090507.png`; `imageExtFor("image/jpeg","")` → jpg, `("","Shot.PNG")` → png, `("image/svg+xml","a.svg")` → null, `("","notes.md")` → null; `resolveImageSrc`: `assets/a.png`, `./a.png` (noteDir `<root>/wiki`), `../raw/a.png`, `/assets/a.png`, `https://…`/`data:…`/`asset://…` → null, `my%20img.png` decoded.
`src/lib/markdown.test.ts` (extend): `## Two` → `<h2 data-line="…">`; `![x](assets/a.png)` with env `{vaultRoot, toUrl: p => "u:" + p}` → `src="u:<root>/assets/a.png"`; `https://` src untouched; no env untouched; `![[shot.png]]` → `<img src="…assets/shot.png"`; `![[note]]` → unchanged wikilink text.
`src/lib/outline.test.ts`: ATX levels/text/0-based lines; setext → level 1; `#` inside a fence skipped; inline markup stripped (`**b**`→b, `` `c` ``→c, `[[L|Alias]]`→Alias); empty → `[]`; `bodyLineOffset`: none → 0; `---\na: 1\n---\n` → 3; `---\na\nb\n---\n` → 4; CRLF variant.
`src/stores/vaultStore.test.ts` (extend): `resolveWikilink("Note#Sec")` finds `Note.md`; `openWikilink("#Sec")` → null and no `ipc.createFile` call (spy).
Rust `vault.rs mod tests`: `write_asset_creates_dir_and_suffixes_collisions` (tempdir; `assets/x.png` then `assets/x-2.png`, bytes round-trip); `write_asset_refuses_bad_names_types_and_size` (`a/b.png`, `..`, `x.svg`, `x` → Err; `vec![0; MAX_ASSET_BYTES+1]` → Err containing "20 MB"); `scaffold_obsidian_vault` test (if any) updated to `assets`. `parser.rs mod tests`: `strips_heading_anchor` (`[[note#Sec]]`, `[[note#Sec|alias]]` → `["note"]`; `[[#only]]` → `[]`).
Browser (`?mock=1`): `/` menu in ko (`/표` → table), `tags:` list, ⌘F panel in ko and dark, outline click in split and live modes, paste (mock returns a fixed path). Headed real-vault check: asset protocol rendering after `cargo build`.

## Edge cases & failure handling
`/` meant literally (`/usr/bin`): menu opens, the first space or Esc closes; nothing altered until applied. Heading anchors navigate to the note, not the heading (follow-up). Two pastes within one second → `-2`. `assets/` shows in the sidebar as an empty folder (list_files hides non-.md, vault.rs:1096-1122) — mirrors Obsidian. Asset scope accumulates across vault switches within one app run — same trust level as `read_file`; noted. No vault open → Rust `no vault is open` surfaces through `onError`. Outline: derived synchronously from `draft` (states: not rendered / empty / success); `data-line` miss → editor still scrolls; line clamped to `doc.lines`. Outline for Live mode uses the editor scroll only. `?mock=1` shows a broken image for `assets/` sources (mock has no vault images — documented blind spot).

## Estimated diff size (lines) and risk
P1a ≈ 420 (editorCompletions 90+70 test, Editor +110, vaultStore/parser +8, i18n ~120, lockfile). P1b ≈ 380 (assets 45+50, markdown +40 (+20 test), Viewer +10, Editor +40, PageReader +15, Rust 60 (+45 test), ipc/devMock/lib.rs/Cargo/conf +15, i18n +10). P1c ≈ 300 (outline 45+45, OutlinePanel 45, markdown +6, PageReader +45, uiStore +4, styles +60, i18n +20, Editor +8). Risk: P1a low; P1b medium (raw-body invoke — new pattern, verified against tauri 2.11.1; `protocol-asset` build feature; run `cargo build && cargo clippy` first and commit Cargo.lock separately); P1c low.

## Follow-ups explicitly excluded
Image drop (`onDragDropEvent` + `copy_asset`, with a bounds check that keeps PageIngest's subscriber — App.tsx:78-90 mounts both in split view); heading completion + scroll-to-anchor after cross-note navigation; body `#tag` indexing; ⌘F from Preview (`openSearchPanel`, search d.ts:380, via a lifted ref); outline scroll-spy; SVG/BMP assets; unreferenced-asset cleanup; `outlineOpen` in `settingsBundle`.

---

# P2 Sidebar management — selection, Move to…, favorites, recently edited, back/forward

## Goal (2 lines) & how it reduces "hard to manage" vs Obsidian/Notion
Make the file tree a place where notes are actually managed: select many, move, star, see what changed, go back — with a context menu that is styled and keyboard-operable. Obsidian's "Move file to…"/starred/back-forward and Notion's favorites/multi-select, minus drag-to-move (blocked by the platform, see sprint follow-ups).

## UX behavior
**Rows (`TreeNode` 292-328 / `DirectoryRow` 330-379).** Plain click unchanged and clears the selection. Cmd/Ctrl-click toggles a file or folder row in the selection (`.is-selected` + `aria-pressed`; left accent bar + `--bg-active` + a `check` glyph replacing the page/folder icon — not colour-only) and sets the anchor. Shift-click selects the contiguous range in the *visible* order (`flattenVisible`, honouring `expandedFolders`). Space on a focused row toggles it (preventDefault). Escape in the aside clears selection and closes the menu. Enter opens as before. ≥1 selected → the Pages label shows a `pill` `{n} selected ×` (`sb_selected`, `sb_clear_selection`). Selection clears on plain click, Escape, vault switch and after any bulk action. Rows get `user-select: none`.
**Context menu (moved verbatim to `src/components/SidebarMenu.tsx` first; then extended).** CSS added (`.myco-menu` fixed at `clientX/clientY`, `--bg-elev`, `--line`, `--shadow-pop`, `.myco-menu__sep`, `.myco-menu__danger` in the `.myco-modal__btn--danger` colour). First item `autoFocus`; ArrowUp/Down move focus among the buttons; Escape closes; focus returns to the opener (`showMenu` records `document.activeElement`); `Shift+F10`/`ContextMenu` key on a focused row opens the menu at the row's rect. Items: New note · New note from template… (P4) · New folder · sep · file only: Add to / Remove from favorites · **Move to…** · n ≤ 1: Rename…, Delete (message now says "moves to the Trash" — `delete_path` is `trash::delete`, vault.rs:858-864) · n ≥ 2 and the row is in the selection: **Delete {n} items** (one confirm). Right-click on a synthetic group row does nothing.
**Move to…** — `pickDialog` (P4) titled `sb_move_title` listing destination folders as full-width buttons: `sb_move_root` (vault root) + every directory of `fileTree` (all depths, vault-relative labels), excluding `raw/` and its subtree, synthetic groups, the moving paths and their descendants, and the current parent. Pick → `movePaths(paths, dir)` (the selection when the row is selected, else the row). The open note follows its new path (`replaceRoute`, no history entry); tree refreshes; expanded state unchanged.
**Favorites / Recently edited** — two synthetic directory nodes (`__favorites`, `__recent`) rendered through `TreeNode` at the top of the Pages tree (caret, count, expand persistence and leaf rendering for free). Favorites: expanded by default (default state AND merge — a fresh install never runs `merge`), hidden when nothing starred; starred files that still exist, in star order. Recently edited (`sb_recent` = "Recently edited" — the source is mtime, `recentAuthored` vaultPulse.ts:150, not opens): collapsed by default, always shown when a vault is open; `ipc.fileMtimes` is fetched only while it is expanded (no vault walk for a collapsed group); 5 rows. Leaves inside the groups act on the real file.
**Back / Forward** — Topbar.tsx (after l.40) gets two `icon-btn`s (`arrowL`/`arrowR`, `disabled` when nowhere to go, `aria-label`+`title` = `tb_back`/`tb_forward`). ⌘[ / ⌘] in the App.tsx keydown effect (476-494), skipped when `e.defaultPrevented` (CodeMirror's `defaultKeymap` binds `Mod-[`/`Mod-]` to indentLess/indentMore — @codemirror/commands dist/index.js:1695-1696 — and @codemirror/view calls `preventDefault()` for a handled binding, dist/index.js:4526, before the window listener runs; no `activeElement` fallback needed). HelpWidget gains the two rows.
**States**: favorites read failure → `[]` silently (best effort, like page opens); move/delete/star failures → `vaultStore.error` shown under the tree as a `role="alert"` `.sb-error` line (the Sidebar never rendered `error` before); loading states absent (nav rows, not panels).

## Files to touch (existing) / Files to create
Touch: `src/components/Sidebar.tsx`, `src/components/Topbar.tsx`, `src/components/HelpWidget.tsx` (65-73), `src/App.tsx` (476-494), `src/stores/uiStore.ts`, `src/stores/vaultStore.ts`, `src/lib/ipc.ts` (after 780), `src/lib/devMock.ts` (near 2622), `src/lib/icons.tsx` (`star`), `src/lib/i18n.ts`, `src/styles.css`, `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (after `commands::rename_path,` l.177).
Create: `src/components/SidebarMenu.tsx` (pure move of `ContextMenu`, Sidebar.tsx:404-500, in its own commit before the additions), `src/lib/navHistory.ts` + `.test.ts`, `src/lib/treeOps.ts` + `.test.ts`.

## New/changed functions & types
```ts
// src/lib/navHistory.ts (pure)
export const HISTORY_CAP = 50;
export interface NavHistory { entries: RouteId[]; idx: number }
export function pushRoute(h: NavHistory, route: RouteId): NavHistory;      // truncates forward entries; no-op when route === current; cap hard-coded
export function replaceCurrent(h: NavHistory, route: RouteId): NavHistory; // rename/move route sync, no growth
export function step(h: NavHistory, delta: -1 | 1): NavHistory | null;     // null when out of range
export function sanitizeHistory(p: Partial<NavHistory> | undefined, route: RouteId): NavHistory; // persisted stack must hold `route` at idx, else [route]

// src/stores/uiStore.ts
navHistory: NavHistory;          // default { entries: ["overview"], idx: 0 }; persisted
goBack: () => void; goForward: () => void;
replaceRoute: (route: RouteId) => void;   // setRoute's patch with replaceCurrent
// setRoute (128-131): set((s) => ({ route, splitRoute: …, navHistory: pushRoute(s.navHistory, route) }))
// merge (166-183): navHistory: sanitizeHistory(p.navHistory, p.route ?? current.route); expandedFolders: { __favorites: true, ...p.expandedFolders }
// default expandedFolders (124): { __favorites: true }

// src/lib/treeOps.ts (pure)
export const FAVORITES_ID = "__favorites"; export const RECENT_ID = "__recent";
export function flattenVisible(tree: FileNode[], expanded: Record<string, boolean>): string[];   // rendered row order
export function rangeBetween(order: string[], anchor: string | null, target: string): string[];  // inclusive either direction; [target] when anchor absent
/** Drops no-ops (already in destDir) and impossible moves (destDir equals or is inside a path). */
export function filterMovable(paths: string[], destDir: string): string[];
/** `to + rest` when `path` is `from` or under it, else null (vaultStore.ts:255-260 logic, one home). */
export function rewritePrefix(path: string, from: string, to: string): string | null;
export function syntheticGroup(id: string, name: string, paths: string[]): Extract<FileNode, { kind: "directory" }>;
/** Move-to choices: root + every directory except raw/ (and below), synthetic ids, `moving` + descendants, and the moving paths' current parent. */
export function folderChoices(tree: FileNode[], root: string, moving: string[]): { path: string; label: string }[];
// one-liners (toggle in a Set, parentDir, relTo, drag payloads) are inlined at their call sites — no exports

// src/stores/vaultStore.ts
favorites: string[];                                         // vault-relative, star order
toggleFavorite: (path: string) => Promise<void>;             // optimistic set, ipc.saveFavorites(next), revert + error on failure
movePaths: (paths: string[], destDir: string) => Promise<void>;
deletePath: (paths: string | string[]) => Promise<void>;     // widened; existing callers unchanged
// openVault (76-100): favorites = await ipc.readFile(`${vault.path}/.myco/favorites.json`).then(f => { const v: unknown = JSON.parse(f.raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }).catch(() => []); set({ favorites }) guarded by seq. reset (302): favorites: []
// movePaths: for (p of filterMovable(paths, destDir)) { const to = await ipc.movePath(p, destDir); afterPathChange(p, to); } in one try; finally refreshTree(); then void refreshLinkGraph()
// module helper afterPathChange(from, to): rewrite activeFile.path (rewritePrefix), the route via replaceRoute (exact + descendant), and favorites entries; renamePath (250-276) replaces its inline block with it
// Favorites children in Sidebar: favorites.map(rel => `${root}/${rel}`).filter(p => existing.has(p)) with existing = new Set(flattenMarkdown(fileTree)) (graphData.ts:460); Recent children: recentAuthored(mtimes, root, 5).map(r => `${root}/${r.rel}`)

// src/components/Sidebar.tsx
// state: selected: Set<string>, anchor: string | null, mtimes: [string, number][] (fetched in an effect on [currentVault, fileTree, expandedFolders.__recent], cancelled flag, only when expanded)
// displayTree = [...groups, ...visibleTree]; order = useMemo(() => flattenVisible(displayTree, expandedFolders))
// function onRowClick(e: MouseEvent, node: FileNode): "handled" | "pass"   — modifier logic first; "pass" runs the existing behaviour
// TreeNode/DirectoryRow props += selected: ReadonlySet<string>; onRowClick; leaf gets aria-pressed + onKeyDown (Space, Shift+F10/ContextMenu)
// showMenu ignores synthetic dir rows and records the opener element

// src/components/Topbar.tsx (after l.40)
// const canBack = useUIStore((s) => s.navHistory.idx > 0); const canFwd = useUIStore((s) => s.navHistory.idx < s.navHistory.entries.length - 1);
// <button className="icon-btn" onClick={goBack} disabled={!canBack} title={t.tb_back ?? "Back (⌘[)"} aria-label={…}><Icon name="arrowL" size={14} /></button> + forward mirror
// src/App.tsx keydown: if ((e.metaKey || e.ctrlKey) && !e.defaultPrevented && (e.key === "[" || e.key === "]")) { e.preventDefault(); (e.key === "[" ? goBack : goForward)(); }  deps += goBack, goForward
// src/lib/icons.tsx: | "star"; paths.star = <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.2 5.9-.8z" />
```
```rust
// src-tauri/src/vault.rs (after rename_path, l.879)
/// Move `from` into directory `to_dir`, keeping its file name. Refuses an existing target and moving a directory
/// into itself or a descendant. Both paths are canonical (confined by the caller), so starts_with is a real ancestry test.
pub fn move_path(from: &str, to_dir: &str) -> Result<String, String>   // std::fs::rename; errors: not found / not a directory / cannot move a folder into itself / destination exists / move failed

// src-tauri/src/commands.rs (after rename_path, l.815)
/// Confinement + raw/ guard, root-injected so it is testable without a Tauri State (copy_into_inbox_at idiom, l.936).
pub(crate) fn move_path_at(root: &Path, from: &str, to_dir: &str) -> Result<String, String>;
#[tauri::command] pub fn move_path(state: tauri::State<VaultRoot>, from: String, to_dir: String) -> Result<String, String>;
/// `.myco/favorites.json`: validates every entry (non-empty, relative, no `..` component, no `\`), dedups in order,
/// create_dir_all(vault_dir::dir(root)) then vault::write_file (atomic).
pub(crate) fn save_favorites_at(root: &Path, paths: &[String]) -> Result<(), String>;
#[tauri::command] pub fn save_favorites(state: tauri::State<VaultRoot>, paths: Vec<String>) -> Result<(), String>;
// No mark_dirty in move_path — rename_path (782-815) has none either; the watcher picks up moves. Backlinks need no rewrite: the stem is
// unchanged and wikilinks resolve by stem vault-wide (findFileByStem, vaultStore.ts:322; rewrite_backlinks is stem-keyed, commands.rs:805-812).
```

## IPC additions
| command | params (Rust / JS) | returns | Rust validation |
|---|---|---|---|
| `move_path` | `from, to_dir` / `{ from, toDir }` | `String` new absolute path | `require_root`; `confine_path` both; refuse `is_raw_path` on **either** side (`refused: raw/ is immutable — sources cannot be moved in or out`); `to_dir` is a directory; target must not exist; no dir-into-self |
| `save_favorites` | `paths: Vec<String>` / `{ paths }` | `()` | `require_root`; per-entry rules above; dedup |

`ipc.ts` after `renamePath` (779-780): `movePath: (from: string, toDir: string) => invoke<string>("move_path", { from, toDir })`, `saveFavorites: (paths: string[]) => invoke<null>("save_favorites", { paths })`. `lib.rs`: `commands::move_path, commands::save_favorites,` after l.177. `devMock.ts` (near 2622-2624; module-level `let mockFavorites: string[] = []`): `case "move_path": return Promise.resolve(\`${String(args.toDir)}/${String(args.from).split("/").pop()}\`);` `case "save_favorites": mockFavorites = args.paths as string[]; return Promise.resolve(null);` and `read_file` of `…/.myco/favorites.json` → `{ raw: JSON.stringify(mockFavorites) }`.

## i18n keys (optional; under `// Sidebar.` l.1102-1110, `// Topbar.` l.1122, `hw_sc_*` beside l.144)
| key | en | ko | ja |
|---|---|---|---|
| sb_favorites | Favorites | 즐겨찾기 | お気に入り |
| sb_recent | Recently edited | 최근 수정 | 最近編集 |
| sb_fav_add | Add to favorites | 즐겨찾기에 추가 | お気に入りに追加 |
| sb_fav_remove | Remove from favorites | 즐겨찾기에서 제거 | お気に入りから削除 |
| sb_move_to | Move to… | 이동… | 移動… |
| sb_move_title | Move {n} item(s) to | 항목 {n}개 이동 | {n}件を移動 |
| sb_move_root | Vault root | 볼트 루트 | ボルトのルート |
| sb_delete_n | Delete {n} items | {n}개 항목 삭제 | {n}件を削除 |
| sb_delete_n_q | Delete {n} items? | {n}개 항목을 삭제할까요? | {n}件を削除しますか? |
| sb_delete_msg | {n} item(s) will move to the Trash. | 항목 {n}개가 휴지통으로 이동합니다. | {n}件をゴミ箱に移動します。 |
| sb_delete_one_msg | “{name}” will move to the Trash. | “{name}”이(가) 휴지통으로 이동합니다. | 「{name}」をゴミ箱に移動します。 |
| sb_selected | {n} selected | {n}개 선택 | {n}件選択 |
| sb_clear_selection | Clear selection | 선택 해제 | 選択解除 |
| sb_new_folder_msg | Folder name | 폴더 이름 | フォルダー名 |
| sb_rename_msg | Rename “{name}” to: | “{name}”의 새 이름: | 「{name}」の新しい名前: |
| sb_empty_vault | Empty vault | 빈 볼트 | 空のボルト |
| sb_no_vault | No vault selected | 선택된 볼트가 없습니다 | ボルトが選択されていません |
| tb_back | Back (⌘[) | 뒤로 (⌘[) | 戻る (⌘[) |
| tb_forward | Forward (⌘]) | 앞으로 (⌘]) | 進む (⌘]) |
| hw_sc_back | Back | 뒤로 | 戻る |
| hw_sc_fwd | Forward | 앞으로 | 進む |

(`sb_new_folder_msg`, `sb_rename_msg`, `sb_delete_one_msg`, `sb_empty_vault`, `sb_no_vault` replace hardcoded English on the lines being edited — Sidebar.tsx:209, 432-433, 443-444, 458. Reused: `sb_new_note`, `sb_new_folder`, `sb_rename`, `sb_delete_file_q`, `sb_delete_folder_q`, `dlg_delete`.)

## Tests
`src/lib/navHistory.test.ts`: push appends/moves idx; pushing the current route is a no-op; push after back truncates forward; 51 pushes keep 50 (oldest dropped, idx 49); `step` out of range → null; `replaceCurrent` keeps idx; `sanitizeHistory` (undefined → `[route]`; mismatch → `[route]`; valid passes).
`src/lib/treeOps.test.ts`: `flattenVisible` (collapsed dir contributes itself; expanded contributes children; nested); `rangeBetween` (forward, backward, anchor missing/not in order → `[target]`); `filterMovable` (drops already-in-dest, dest itself, ancestor of dest; keeps others); `rewritePrefix` (exact, descendant, `/a/b` vs `/a/bc` → null, unrelated); `syntheticGroup` shape; `folderChoices` (root first; excludes `raw/` and `raw/x`; excludes moving path + descendants; excludes current parent; labels vault-relative).
`src/stores/vaultStore.test.ts` (extend): `deletePath([a,b])` → 2 `ipc.deletePath`, 1 `refreshTree`, nulls `activeFile` under `b`; `movePaths` skips non-movable, rewrites `activeFile.path`, calls `replaceRoute` (spy on uiStore) and `navHistory` length unchanged; `toggleFavorite` adds then removes, `saveFavorites` called with rel paths, IPC failure reverts + sets `error`; `openVault` with a corrupt favorites file → `[]`.
`src/stores/uiStore.test.ts` (new): `setRoute` pushes; `goBack`/`goForward` change `route`; `replaceRoute` does not grow the stack; merge with a stale stack sanitizes; fresh default has `expandedFolders.__favorites === true`.
Rust `vault.rs mod tests` (`temp_vault` l.1371): `move_path_moves_file_into_dir`; `move_path_refuses_existing_target`; `move_path_refuses_dir_into_itself_or_descendant`; `move_path_refuses_non_directory_dest`. `commands.rs mod tests` (canonicalized tempdir root, l.4707 idiom): `move_path_at_refuses_raw_on_either_side` (`raw/a.md → wiki/` and `wiki/a.md → raw/` Err containing `raw/`; `wiki/a.md → notes/` ok); `save_favorites_at_dedups_validates_and_round_trips` (order kept; `..`/absolute/backslash rejected; file readable as JSON).
Browser (`?mock=1`): Cmd-click two files → pill "2 selected"; right-click → "Delete 2 items"; Move to… → dialog lists folders, pick → route unchanged for an unrelated open note; star → Favorites group appears; ⌘[ returns to the previous route; ⌘[ inside the editor de-indents without navigating; Shift+F10 on a focused row opens the menu.

## Edge cases & failure handling
raw/: Rust refuses either side; `folderChoices` hides `raw/`; delete already refused (commands.rs:774-776). Overwrite refused (`destination exists`); the rest of a multi-move continues, one error surfaces. Moving the open note → `replaceRoute` → `VaultPage` remounts by key and reopens. Pre-existing hazard shared with rename: the unmount flush (PageReader.tsx:238-255) writes a dirty draft to the *old* path within ≤2 s of the last keystroke (follow-up). Favorites entries whose file is gone are hidden, not pruned; rename/move rewrites them; corrupt JSON → `[]` and the next star overwrites. Recent: a bulk edit (P3) or distill run fills it with machine writes — the label says "edited", not "opened"; the `recentAuthored` ingested-folder filter still applies. History: back to a deleted page shows the store `error` in PageReader's `!activeFile` branch; rename/move never create dead entries. Selection: range uses visible order so collapsed children are never silently included; synthetic rows are neither selectable nor menu targets. Context menu: no viewport clamping (~8 rows; acceptable).

## Estimated diff size (lines) and risk
TS/TSX ≈ 620 (SidebarMenu move ±100 + additions 90, Sidebar +150, vaultStore +75, uiStore +30, Topbar +20, App +8, HelpWidget +2, icons +3, ipc +4, devMock +10, i18n ~90, navHistory 40, treeOps 90, styles +55) + TS tests ≈ 220; Rust ≈ 150 (vault +20/+45 tests, commands +45/+35 tests, lib.rs +2). Total ≈ 1,000 incl. tests. Risk: medium — Sidebar.tsx stays under ~600 lines only because the menu moves out; keydown interplay with CodeMirror verified against the installed packages; `deletePath` widening is source-compatible.

## Follow-ups explicitly excluded
Drag-to-move (platform-blocked, see sprint follow-ups); sidebar bulk tag (Views has it); fixing the rename/move unmount flush; pruning favorites on delete; favorites for folders; drag-reorder of favorites; recent-by-opens (`page_opens.rs` reader IPC); `Shift+Arrow` range selection; `role="tree"` ARIA; viewport clamping; Windows/Linux `Ctrl` glyphs in labels (whole app hardcodes ⌘); debouncing `fileMtimes` for very large vaults (measure first).
