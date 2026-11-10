# Mobbin research — Obsidian family → myco

Key: `obsidian`. Date: 2026-09-26. Platform: Obsidian is on Mobbin as **iOS only**
(no web/desktop set). Logseq and Roam Research are **not on Mobbin** — the
"Logseq journal", "Logseq graph" and "Roam daily notes" searches returned
unrelated apps (Evernote, Dot, Craft, Tana, Profound, Causal). Where a web
comparison was useful I used Tana (web), which was returned for the Roam query.
17 searches run; every pattern below was read off the returned image, not the
metadata.

myco code cited is the installed tree:
`~/prj/karpathy-editor-build/app/src`.

## What Obsidian does that myco already does (parity — do not rebuild)

- Graph **Display** group (Arrows, Text fade threshold, Node size, Link
  thickness, Animate) — [screen](https://mobbin.com/screens/fe673348-8160-48be-a481-66560fb027d7).
  myco has `arrows`, `textFadeThreshold`, `nodeSize`, `linkThickness`
  (`lib/graphSettings.ts:110-119`), timelapse (`tlPlaying`), and `GraphSlider`
  even adds a typed numeric field where Obsidian only shows a drag bubble
  ("3.19" — [screen](https://mobbin.com/screens/3fd194f3-34ff-4046-ac01-ba9b1e637bb7)).
- Graph **Forces** (Center / Repel / Link force / Link distance) —
  [screen](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c);
  myco `graphSettings.ts:171-173` mirrors them by name.
- Graph **Filters** (search, Tags, Existing files only, Orphans, reset icon) —
  [screen](https://mobbin.com/screens/a4e27535-090f-40de-81c2-fa8e83703b8b);
  myco `GraphControls.tsx` Filters section has search, tag chips, folder select,
  Show orphans, Existing files only, Reset.
- Hover neighbourhood highlight: `pages/PageGraph.tsx:870` builds the
  neighbour set on hover.
- Bookmarks ([screen](https://mobbin.com/screens/3490827b-985a-4cf7-b087-9e25b66b0469))
  ≈ myco Favorites (`lib/treeOps.ts FAVORITES_ID`).
- Daily note button ([screen](https://mobbin.com/screens/53217838-d7d2-48b8-9c36-30aa3ce9978b),
  bare `2026-04-28` page) ≈ `Sidebar.tsx:543 DailyNoteButton`.
- Vault file count in the sidebar footer ("4 files, 1 folder") ≈ myco
  `StatusStrip.tsx:137` note count; vault name lives in `Topbar.tsx:45`.
- Local graph: the search "Obsidian local graph … depth" returned **zero**
  screens, so there is no Mobbin evidence for local graph / depth slider. myco
  has a 1-or-2-hop frame (`PageGraph.tsx:136 hopSet`, double-click upgrades to
  2 hops) but no depth control — recorded as unverified, not as a pattern.

## Patterns with a real myco gap

### 1. Backlinks carry the sentence that links here (context snippet), grouped per source note
- Evidence: [linked mentions expanded](https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e) — under "Linked mentions 1" the row "Moodboard" expands to the paragraph "...an, gritty, a little nostalgic… **[[2 Day Trip Plan to NYC]]**" with the link highlighted yellow; [collapsed variant](https://mobbin.com/screens/0ef5d4b3-1972-4f6a-a980-fb862061ea0c) shows just "[[Moodboard]]" as the snippet; a search field sits above the list. Tana web does the same with a timestamp per mention ([Backlinks: "Mentioned in ASMOBBIN Stand Up · Jun 12, 9:00 AM"](https://mobbin.com/screens/4d9dbade-0131-4d20-8996-89720b17c41b)).
- myco: `components/ConnectionsPanel.tsx` renders each backlink as tag + name + optional % only; `lib/readerRail.ts ConnRow` has no snippet field. The reader never shows *why* a note links here.
- Proposal: add `snippet?: string` to `ConnRow` for `backlink` rows, filled from the existing `ipc.searchVault("[[<stem>", n)` line hits (Rust substring scan already returns `snippet` + `line`); render as a second muted line, `<mark>` on the link. No new backend.
- Impact high · Effort M.

### 2. "Unlinked mentions" — notes that name this page in plain text but never link it
- Evidence: [backlinks pane](https://mobbin.com/screens/2581a5fc-7bc7-4e33-b2a5-5d5cd12e70d6) — two fixed headers, "Linked mentions 1" and "Unlinked mentions", the second empty but always present; [outgoing links pane](https://mobbin.com/screens/b74df2ce-1701-451a-b5e2-ba2680e8ebb1) has the same "Unlinked mentions" section.
- myco: no plain-text mention scan in the reader; `grep unlinked` hits only graph gap copy and semantic suggestions. `ConnectionsPanel` "Suggested" rows are embedding pairs, not textual mentions.
- Proposal: in `connectionRows`, add kind `"mention"` = `ipc.searchVault(stem)` hits whose path is not in `backward[filePath]`; reuse the existing accept path (`acceptSuggestion`) so the ✓ button turns the mention into a `[[link]]`. Show under its own header even when empty (0), as Obsidian does — it teaches the concept.
- Impact high · Effort M.

### 3. Outgoing links list in the reader rail
- Evidence: [outgoing links](https://mobbin.com/screens/b74df2ce-1701-451a-b5e2-ba2680e8ebb1) — "Links 1 · Moodboard" with a link icon, then "Unlinked mentions".
- myco: `ReaderRail.tsx` stacks Properties → Outline → Sources → Connections; `adjacency.forward[path]` is read in `PageReader.tsx:662` only to pick audio-overview neighbours. Outlinks appear only in `GraphInspector.tsx` ("Links (n)"), not while reading.
- Proposal: push `forward[filePath]` rows as kind `"outlink"` into `connectionRows` (one new `push` loop, new `rail-tag t-outlink`). Dedupe rule already handles a page that is both.
- Impact medium · Effort S.

### 4. Rail pane switcher + note statistics footer
- Evidence: [pane menu](https://mobbin.com/screens/88d24bae-ee98-42b9-9180-2421eb4af47e) — a bottom dropdown swaps one pane between Backlinks / Outgoing links / Outline; the footer under it reads "2 Day Trip Plan to NYC · 87 words, 579 characters" with a toggle-hidden icon; [same footer on outgoing links](https://mobbin.com/screens/b74df2ce-1701-451a-b5e2-ba2680e8ebb1).
- myco: no word/character count anywhere (`grep words` in PageReader/StatusStrip/Topbar → 0). The rail is a fixed vertical stack.
- Proposal: one line under the reader rail (`ReaderRail.tsx`) with `Intl.NumberFormat` word + char count computed from the open draft. Skip the switcher — myco's stacked `<Rail>` collapsibles already solve the same problem.
- Impact low · Effort S.

### 5. Colour groups by query in the graph
- Evidence: [Groups section](https://mobbin.com/screens/e63e0d58-44f1-4970-8eba-13eca5f54b4a) — "Enter query…" input, a red swatch, ×, and a full-width "New group" button; [two groups active](https://mobbin.com/screens/71318baf-b814-4435-806b-cdb772ee14a6) — "Trip" (red) and an empty row (yellow), the "2 Day Trip Plan to NYC" node painted red on the canvas; [typing "Trip"](https://mobbin.com/screens/cb5ed1c3-4e42-457b-a170-0cc4f417345a).
- myco: node colour is `nodeColor: "community"|"white"|"black"|"auto"` (`lib/graphSettings.ts:98`); grouping is folder/Louvain only (`GraphLegend.tsx`). The owner cannot say "everything `status:disputed` is red" or "`tag:#todo` is amber".
- Proposal: `groups: { query: string; color: string }[]` on `GraphSettings`; classify nodes with the already-existing `parseSearchQuery` + `hitPassesFilters` (`lib/searchQuery.ts`), first matching group wins; append group rows to `GraphLegend` above the encoding key. Same operator grammar as ⌘K, so one syntax to learn.
- Impact high · Effort M.

### 6. Operator hints as a popover, not a footer line
- Evidence: [search options](https://mobbin.com/screens/ac93a668-ffbc-43dd-8437-8428767713a1) — focusing the Groups query shows "Search options ⓘ" listing `path:` match path, `file:` match file name, `tag:` search for tags, `line:` same line, `section:` same heading, `[property]` match property, one per row.
- myco: `CommandBar.tsx:469` prints "Quotes for exact match · path: · tag:" as 11.5px muted text; `parseSearchQuery` also accepts `type:` `status:` `confidence:` but nothing on screen says so. The graph filter's only hint is the placeholder `path:wiki tag:#concept`.
- Proposal: when the query is empty (or the caret is after a bare word), render a `cmd-group-label` "Operators" with 6 rows (`"phrase"`, `path:`, `tag:`, `type:`, `status:`, `confidence:`); clicking inserts the operator. Reuse in the graph Filters search field.
- Impact medium · Effort S.

### 7. Quick switcher creates the typed note on Enter
- Evidence: [New tab quick switcher](https://mobbin.com/screens/dcb9db86-4207-4c0a-936c-8734b792e2e2) — placeholder "Find or create a note…", three existing notes listed, blue ⏎ key; [dark variant](https://mobbin.com/screens/2d7a3707-09a1-4941-aaad-d65ee647341b).
- myco: `CommandBar.tsx:164-175` always lists a "New note" action row that opens `promptNewNote` (a second dialog asking the name again). A miss with a typed name gives no "create this" row.
- Proposal: when `q` matches no file leaf, prepend an action row `Create "{q}"` that calls `promptNewNote(t, { name: q })` (or creates directly in the current folder). One row, one function argument.
- Impact medium · Effort S.

### 8. Fuzzy-match highlighting in palette rows
- Evidence: [command palette "copy"](https://mobbin.com/screens/44992a64-b821-48c5-ade2-c3e80525b978) — "**Copy** Obsidian URL…", "**Copy** current file path…", "File re**co**very: O**p**en local histor**y**" with matched letters bold.
- myco: `CommandBar.tsx:380-395` prints `r.label` plain; content hits print `h.snippet` plain (no `<mark>`).
- Proposal: split label on the matched substring and wrap it in `<mark>` (myco matches by `includes`, so it is one `indexOf`).
- Impact low · Effort S.

### 9. Search results grouped by note with per-note counts and a result summary line
- Evidence: [search pane](https://mobbin.com/screens/3add8f95-d23d-42ec-92c2-0c23eb5c096b) — "5 results ●", sort "File name (A to Z)", `Aa` case toggle, results grouped under collapsible note titles ("2 Day Trip Plan to NYC 2"), each match a bordered snippet with the term highlighted yellow; [collapsed](https://mobbin.com/screens/05f1224b-eabe-4ef0-b38e-0812773e8a40) shows "Matches text: 'Tr'" as an explanation line.
- myco: `CommandBar.tsx:415-445` lists content hits flat, one row per line hit (a note with 6 hits takes 6 rows), no count, no sort, no highlight.
- Proposal: group `contentHits` by `h.path` → note row with count badge, snippets nested; "n results" in the group label. Sort stays relevance.
- Impact medium · Effort M.

### 10. File explorer: sort menu + collapse-all in the tree toolbar
- Evidence: [file pane](https://mobbin.com/screens/9a0771d2-d259-416f-b986-469d4c626c71) — bottom toolbar icons: new note, new folder, sort, expand/collapse, plus a "Move into 'Itinerary'" drag tooltip and type badges BASE / CANVAS on rows; [sort sheet](https://mobbin.com/screens/4431aecb-6cbe-4094-b192-76c57e2a79fc) — File name A→Z/Z→A, Modified new→old/old→new, Created new→old/old→new.
- myco: `Sidebar.tsx` has no sort and no collapse-all (`grep sort|collapse` → 0); `SidebarTree.tsx` has folder counts. `ipc.fileMtimes` exists and is already fetched for the Recent group.
- Proposal: a `sort` value in `uiStore` (`name` | `modified`), applied in the tree render with the mtimes map; a collapse-all button that clears `expandedFolders`.
- Impact medium · Effort S.

### 11. File context menu: metadata header, Duplicate, Copy path, version history
- Evidence: [context sheet](https://mobbin.com/screens/5964c921-3ae7-4f36-9fcb-81f8df0ee624) — header "Moodboard.md · Last modified at 2026-04-28 10:08 · Created at 2026-04-28 10:05", then Open in new tab / Duplicate / Move file to… / Bookmark… / Merge entire file with… / Copy path › / Open version history / Share; [rest](https://mobbin.com/screens/09dec6de-5d1b-4020-922b-ad238e77263c) ends with Rename… and red Delete.
- myco: `components/SidebarMenu.tsx:154-196` offers New note, New from template, New folder, Favorite toggle, Move to…, Rename, Delete. No Duplicate, no Copy path, no dates, and the reader `Topbar.tsx` has no note-level "…" menu at all (its labels are nav/back/forward/split/model).
- Proposal: add `Duplicate` (readFile → createFile "<name> copy.md") and `Copy path` (`navigator.clipboard.writeText`) to `SidebarMenu`, and a one-line mtime header (mtimes are already loaded). Expose the same menu from a "…" in the reader header so a note can be renamed/moved without going to the tree.
- Impact medium · Effort S.

### 12. Per-note version history ("File recovery")
- Evidence: [file recovery](https://mobbin.com/screens/a41cd3b3-79a3-4fbb-833c-c2a42655fec7) — search "2 Day Trip Plan to NYC", snapshots "Tue, Apr 28, 2026 9:55 AM · 567 B", "Mon, Apr 27 5:54 PM · 546 B" …; [entry](https://mobbin.com/screens/7828a8c2-302c-4ea1-8e84-b4c77464074d) "Open local history / Load more".
- myco: `pages/PageHistory.tsx` is the vault's *ingest-run* history; the reader's "See it in history" (`PageReader.tsx:518`) lands there. No per-file snapshot list; `lib/ipc.ts` has no file-level git log. The Q4 roadmap's opt-in git is the natural backer.
- Proposal: `git log --follow --format=%H%x09%at -- <rel>` in Rust behind `ipc.fileHistory(path)`; a "History" `<Rail>` in the reader listing date + size, opening the existing `DiffView.tsx` against HEAD. Matters for an LLM wiki: the owner can see what the agent changed on *this* page.
- Impact high · Effort L.

### 13. Tags pane with counts
- Evidence: [tags pane](https://mobbin.com/screens/db670cff-67d6-433c-aaf3-4bf89931a121) — "dinner 1", "Pizzas 1", toolbar with sort / nested-toggle / collapse / search.
- myco: no tags list in the sidebar (`grep tagIndex|sb_tags` → tests only); tags are reachable only as graph chips (`GraphControls.tsx` Tags) and as `tag:` in ⌘K. `adjacency.tags` is already in memory.
- Proposal: a "Tags" group under the sidebar Tools disclosure built from `adjacency.tags` (count per tag, alphabetical); click opens ⌘K prefilled with `tag:<name>`. No backend.
- Impact medium · Effort S.

### 14. Property key autocomplete + "All properties" registry
- Evidence: [adding a property](https://mobbin.com/screens/e7717b14-574c-422f-b9f9-5c7e0b47e9fe) — the empty key field pops "aliases / cssclasses / tags" with type icons; [inline properties block](https://mobbin.com/screens/5596b24a-9d62-48b0-a14c-1b5c30d1c03e) — "Properties" header above the body with "nyc: Plan" and "+ Add property"; [All properties pane](https://mobbin.com/screens/c98bbb65-e3c6-4c66-a48e-29bb70e469a5) — every key with usage count (aliases 0, cssclasses 0, tags 0).
- myco: `PropertiesPanel.tsx AddRow` is a free-text key input validated by `KEY_RE`, no suggestions; the typed keys (`type/status/confidence/tags`) exist in `lib/frontmatter.ts` but are not offered when adding.
- Proposal: `<datalist>` on the key input fed by `FM_TYPES`-style known keys ∪ keys seen in `adjacency.meta`; show a count next to each. Native element, no new component.
- Impact medium · Effort S.

### 15. Commands carry their hotkey; pinned commands; hotkey assignment
- Evidence: [pinned commands](https://mobbin.com/screens/8675388e-3370-4420-8c5f-9f24aba5126e) — "Pinned commands" list (Save current file, Follow link under cursor …) each with an icon; [hotkeys settings](https://mobbin.com/screens/93429094-0741-43dd-bd2b-bca81229b3d0) — "Showing 184 hotkeys", filter box, each command with a "Blank" or "⌘ ;" chip and a ⊕ to assign, "Press hotkey…" state; [full command list](https://mobbin.com/screens/d3ebbcbe-e642-4c7a-b2f1-7f5a1b492b90) — Add alias, Add cursor above/below, Add embed, Add file property, Add internal link, Add tag, Backlinks: Show backlinks…
- myco: `CommandBar.tsx` has exactly two actions (New note, New from template); the shortcut list is a static array in `HelpWidget.tsx:64-80` and is not shown on palette rows; keys are hard-wired in `App.tsx`.
- Proposal: one `lib/commands.ts` table `{ id, label, key?, run }` consumed by `App.tsx` (keydown), `CommandBar` (rows with a right-aligned `<kbd>`), and `HelpWidget` (list). Then every existing action (toggle sidebar, back/forward, fly mode, spotlight, voice) becomes searchable. Defer user rebinding.
- Impact medium · Effort M.

### 16. Wikilink autocomplete shows the note's folder
- Evidence: [`[[` popup](https://mobbin.com/screens/648fdde3-4975-40ba-a8d8-c9eec6fb5c0a) — after typing `![[`, rows "2 Day Trip Plan to NYC" with "Itinerary/" beneath in grey, and "Mood board"; [same for `[[`](https://mobbin.com/screens/99d28878-15e3-4630-9add-02990ad1626f); [flow: Adding an internal link](https://mobbin.com/flows/5e0136a3-1e00-47cc-8e24-1d39b9e88d81).
- myco: `components/Editor.tsx:689-710 wikilinkCompletion` maps files to `stripExt(name)`, dedupes by stem and offers `{ label, type: "text" }` — two notes with the same stem in different folders collapse into one row and the user cannot tell which they are linking.
- Proposal: keep the path per candidate and set CodeMirror's `detail: folder` (rendered grey on the right); dedupe by full path, not stem.
- Impact medium · Effort S.

### 17. Appearance: accent colour
- Evidence: [appearance](https://mobbin.com/screens/f55205c3-90c8-40c8-ba93-fd573fa5c75a) — Base color scheme "Adapt to system", Accent color swatch with a reset arrow, Themes / Manage, Interface toggles; [colour picker](https://mobbin.com/screens/ed4534ee-c44e-40f5-891e-5474ded3dfe1).
- myco: `pages/settings/Appearance.tsx` has light/dark/system, mascot, overview theme, tray, notch — no accent.
- Proposal: `<input type="color">` writing `--accent` on `:root` + a reset button; persist in `uiStore`. Low priority.
- Impact low · Effort S.

### 18. Onboarding leads with the local-first promise
- Evidence: [first screen](https://mobbin.com/screens/e77414c6-2bee-4455-be64-60b7887b75f5) — "Your thoughts are yours." / "Obsidian stores notes on your device… Your data is stored in a secure local folder called a **vault**." / Create a vault (primary) / Use my existing vault / language picker; [sync step](https://mobbin.com/screens/c464d280-72a1-4984-b7b9-02bed72b99db) — the optional step's primary button is "Continue without sync", the upsell is secondary.
- myco: `OnboardingWizard.tsx:169` title is `ob_title` = "Welcome to myco" (i18n.ts:3510); the sovereignty line exists (`ob_sovereignty`) but is not the headline.
- Proposal: swap the headline to the value statement (the ob_sovereignty copy) and keep "Welcome" as the sub; on the optional import step make "Skip" the filled primary. Copy-only change.
- Impact low · Effort S.

### 19. Canvas — deliberately not a gap to close
- Evidence: [canvas](https://mobbin.com/screens/f660ba6a-02b7-4f05-9103-2b13a84763dd) — a selected connector with delete / colour / zoom-to / edit toolbar; [colour palette](https://mobbin.com/screens/ea4ddeb4-590b-4ac4-8ee0-e6ed3f9a4a80).
- myco: none. Recorded so the question does not get re-asked: a freeform board duplicates the graph's job in a wiki whose structure is meant to come from links, not from hand placement.
- Proposal: skip. If ever wanted, the graph inspector's "Set as path start / Path" is the closest existing affordance.
- Impact low · Effort L.
