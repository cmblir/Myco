# Mobbin research — Reflect / Mem / Heptabase family → myco

Key: `reflect-mem-heptabase`. Platform: web unless noted. 20 searches run; every screen below was looked at, not summarised from metadata.

## Coverage on Mobbin

| App | On Mobbin? | Used instead |
|---|---|---|
| Reflect | Yes (web, ~40 screens) | — |
| Mem | No (query returned ChatGPT, Gemini Notebook, Cohere, Dash, Copilot) | Gemini Notebook, Dropbox Dash, Fabric, Notion AI for "chat with notes" |
| Heptabase | No (query returned ClickUp, Tana, Magnific, Canva, Mural, Craft) | Tana canvas, Craft whiteboard |
| Saner / Twos | No (iOS query returned stoic, Numo, Tiimo, Structured) | Tana Today, Evernote home for daily/quick capture |
| Day One "On this day" | No results (iOS) | mymind Serendipity for resurfacing |

myco surfaces read for every gap claim: `~/prj/karpathy-editor-build/app/src` — `pages/PageQuery.tsx`, `components/AbstainCard.tsx`, `components/RetrievalStepper.tsx`, `components/SourceLadder.tsx`, `components/CommandBar.tsx`, `components/Spotlight.tsx`, `components/Sidebar.tsx` (+`SidebarMenu.tsx`), `pages/PageOverview.tsx`, `components/EverydayHome.tsx`, `components/MorningBand.tsx`, `components/OverviewBoard.tsx`, `components/RecentNotes.tsx`, `stores/resurfaceStore.ts`, `pages/PageGraph.tsx`, `components/GraphControls.tsx`, `components/GraphInspector.tsx`, `components/GraphLegend.tsx`, `pages/PageReader.tsx`, `components/ReaderRail.tsx`, `components/ConnectionsPanel.tsx`, `lib/readerRail.ts`, `components/OnboardingWizard.tsx`, `components/HelpWidget.tsx`, `pages/PageSettings.tsx`, `pages/settings/Appearance.tsx`, `pages/PageHistory.tsx`, `lib/editorCompletions.ts`, `components/BlockMenu.tsx`, `components/NotchPanel.tsx`, `components/NodePreview.tsx`, `components/DatePicker.tsx`, `lib/i18n.ts`.

Already at parity (no pattern recorded): retrieval trace disclosure (Customer.io "Thought for 26s / Searched docs", Copilot "See my thinking") ⇔ `RetrievalStepper`; example questions in the empty Ask state (Evernote AI search) ⇔ `PageQuery` `copy.examples` chips; theme picker with visual previews (Reflect Profile settings) ⇔ `settings/Appearance.tsx` live `ThemeSwatch`; composer model selector + agent toggle (Notion) ⇔ `ModelSelect` + `AgentPanel`.

---

## Patterns

### 1. AI answer — citation hover preview + per-answer feedback (Notion AI)
- **Seen**: Notion meeting notes render each claim with a small numbered superscript; hovering "1" opens a popover with the exact transcript lines (timestamps) behind it. A pill "🔍 8 citations" sits at the bottom next to 👍/👎. https://mobbin.com/screens/fec09ec2-fba4-45b2-98ad-28e6366bd642 · https://mobbin.com/screens/4f5455f9-bd96-4d45-ae56-33838f2e4d71 · https://mobbin.com/screens/81e875fa-61d6-4010-b5d7-201bcaa2e4b1
- **myco today**: `PageQuery.tsx` `ExtractiveAnswer` (l.583-663) gives every quoted paragraph a numbered `.ask-cite` button; hover only lights the matching `SourceLadder` row in the side rail (`ask-split`). No popover at the number, no thumbs. The eval-log path exists elsewhere (`CommandBar` ⌥⏎ "Log a search that missed", `cb_miss_done`).
- **Proposal**: on `.ask-cite` hover/focus show a 1-line popover (stem · tier chip · similarity · heading path of the quote) so the eye never has to travel to the rail; add 👍/👎 per turn writing to the same eval set the ⌥⏎ miss-log uses. — impact medium · effort S

### 2. Pool-size pill inside the composer ("8 sources", "Current file")
- **Seen**: Gemini Notebook's chat input ends with "8 sources →"; Dropbox Dash shows "1 source" under the answer; Fabric's assistant shows a "Current file" scope chip above the input. https://mobbin.com/screens/05def46a-970f-46b2-8bf0-e0e83c7dd49e · https://mobbin.com/screens/c1644911-b9ff-4f0f-a4eb-61145ab23997 · https://mobbin.com/screens/fc54be30-29ff-430c-9554-7858c47373e8 · https://mobbin.com/screens/b392bc22-bf75-4b35-be0a-ae58de609dc2
- **myco today**: the scope chip is rendered on the finished turn (`q_scope_chip`, l.447) and "answering from {n} pages…" only while loading (l.165). Before typing, nothing says how many pages will be searched; `indexedPages` is only visible later in `RetrievalStepper`.
- **Proposal**: put `{indexedPages} pages · {scope}` (from `useReindexStore`) as a clickable pill inside the ask composer; click cycles scope. — impact medium · effort S

### 3. Follow-up chips after an answer (Dash, Gemini Notebook, Fireflies)
- **Seen**: Dash: "Ask a follow-up" + 3 question chips right under the answer; Gemini Notebook: 3 chips ("What are more examples of…"); Fireflies AskFred: "Suggest Questions" list. https://mobbin.com/screens/fc54be30-29ff-430c-9554-7858c47373e8 · https://mobbin.com/screens/c1644911-b9ff-4f0f-a4eb-61145ab23997 · https://mobbin.com/screens/2047129f-d283-45ef-81bb-09aa79a32ffe
- **myco today**: example chips exist only in the empty state (`PageQuery.tsx` l.412-430). After a turn: `UncitedRow` ("Reviewed but not quoted · n") and the ladder, no next question.
- **Proposal**: deterministic follow-ups (no model, keeps the "never invented" identity): chips built from the top cited page's headings (`lib/outline.extractHeadings`) → "What does [[stem]] say about {heading}?", plus one "Ask again scoped to {uncited page}" chip. — impact medium · effort M

### 4. "Save to note" on an answer (Gemini Notebook)
- **Seen**: "🔖 Save to note" button at the top of the answer bubble; Studio rail lists saved notes with "8 sources · 1m ago". https://mobbin.com/screens/05def46a-970f-46b2-8bf0-e0e83c7dd49e
- **myco today**: no save/copy action on a turn (`PageQuery.tsx` grep: only audio generation l.746). The answer is verbatim quotes with page refs — the most wiki-shaped thing the app produces, and it evaporates.
- **Proposal**: per-turn "Save as note" → `wiki/answers/<slug>.md` (question as title, each quote followed by `[[stem]]`, frontmatter `type: answer`) through the existing `ipc.createFile/writeFile`; optional "append to today's daily note". — impact high · effort M

### 5. Search palette: two-pane preview, "Create note '{q}'" fallback, relative dates (Reflect ⌘K)
- **Seen**: results list left with snippet + time, live note preview right; last row is always `Create note 'reflect'`; typing "3 days ago" resolves to "May 2nd, 2023" as the first row. https://mobbin.com/screens/40df0591-51c4-41b0-a14b-9d04e99aa5f3 · https://mobbin.com/screens/f311b2a4-c446-4671-a3b2-ae17f277b8ec · https://mobbin.com/screens/c62fe77f-bdde-4ee0-a51d-627533aa5956
- **myco today**: `CommandBar.tsx` is single-column (Exact / In page contents / Related semantic); "New note" and "New note from template…" are static action rows (l.166-171) that do not take the typed text; no date parsing (no `yesterday`/`days ago` handling anywhere in the file); no preview pane. `NodePreview.tsx` already renders a page inline elsewhere.
- **Proposal**: (a) when `q` has no exact page hit, append `Create "{q}"` calling `promptNewNote` prefilled; (b) parse `today|yesterday|N days ago|YYYY-MM-DD` → open `daily/<date>.md` (reuse `lib/taskLine.today`); (c) right pane = `NodePreview` of the highlighted page row. — impact high · effort M

### 6. Daily note with calendar rail and prev/next day (Reflect)
- **Seen**: daily notes stack (today, then tomorrow's empty stub below); right rail has a month calendar with today highlighted, "Note actions" and "Meetings". https://mobbin.com/screens/a2c5fe18-668a-4f0d-b6a7-917421fba32e · https://mobbin.com/screens/022a2725-10b8-47a8-83ec-3b10206d9bf4 · Tana calendar popover https://mobbin.com/screens/ad6644fa-6e1f-45a3-acee-0a22a27f0f86
- **myco today**: `Sidebar.tsx` `DailyNoteButton` (l.543-590) creates `daily/YYYY-MM-DD.md` with `# date` and opens it in `PageReader`; the reader has no ‹ › day navigation and no calendar; `components/DatePicker.tsx` exists but is used only by `TaskDetail`/`TaskComposer`. Yesterday's note is reachable only via the file tree.
- **Proposal**: when the open path matches `daily/<date>.md`, `PageReader` header gets ‹ date › and a `DatePicker` popover with dots on days that have files (from `fileTree`). — impact high · effort S

### 7. Persistent "Account setup" checklist in the sidebar (Reflect)
- **Seen**: bottom-left "Account setup": ① Create a backlink ✓ ② Save a link ③ Add a meeting — numbered circles turn into checks as each is done; stays until complete. https://mobbin.com/screens/a2c5fe18-668a-4f0d-b6a7-917421fba32e · https://mobbin.com/screens/2f912a5f-28e5-4a89-a337-d980a4e97d7d
- **myco today**: `OnboardingWizard.tsx` is a one-shot 5-step overlay (dots + Skip, `myco.onboarded` flag); after Skip nothing persists. No checklist component in `components/` (grep). `Sidebar.tsx` has no setup block.
- **Proposal**: sidebar block with 3 derived steps — vault linked (`vaultStore.currentVault`), index built (`reindexStore.indexedPages > 0`), first answer or provider set (`queryStore` turns / `settingsStore`). Auto-hides when all true; each row routes to the step. — impact high · effort S

### 8. Backlinks with the referring line (Reflect "Incoming backlinks")
- **Seen**: "Incoming backlinks (1)" at the bottom shows the source note title, then the exact bullet that contains the link ("Grateful for › having a meaningful chat with Alice Hopskin"). Tana's rail adds a timestamp per "Mentioned in" row. https://mobbin.com/screens/fdacd3ac-a6a7-45e9-b6dc-98a47338c16f · https://mobbin.com/screens/916b4bb0-040b-46ed-9909-752d3d2646fb · https://mobbin.com/screens/667840c0-0cf6-4ee7-92b7-af4f52f1c979
- **myco today**: `ConnectionsPanel.tsx` rows = kind tag + name + score% (l.145-200); `lib/readerRail.ts connectionRows` carries no snippet/line (grep empty). Empty state: "Nothing links here yet." + settings CTA when `indexedPages === 0`.
- **Proposal**: for `backlink` rows fetch the referring line via the existing exact search (`ipc.search` with `[[stem]]`) lazily on expand, show one truncated line + mtime under the name. — impact medium · effort M

### 9. Graph: active-filter badge, type toggles, hover property card (Reflect Map)
- **Seen**: "Filters (2)" button shows the count; popover has Access (Published/Private), Type (Daily/Regular), Content (Show unlinked / Show blank) checkboxes; hovering a node shows a card with the page's properties (Title/Company/Type/Email/Location); node size = connections. https://mobbin.com/screens/bcf9fd6e-05ba-4fef-ab8b-6a61d3b86d5d · https://mobbin.com/screens/0e1be504-3f40-4cd2-8968-091212a155e5 · https://mobbin.com/screens/369d3c78-3a65-4b32-909b-7c15bea1c68c
- **myco today**: `GraphControls.tsx` Filters section (l.313-410) — search, tag chips, folder select, Show orphans, Existing files only — inside a drawer that also holds Looks/Layout/Appearance/Motion/Forces; the drawer toggle has no active-count. `PageGraph.tsx` `onNodeHover` (l.869-877, 895-898) only highlights neighbours; properties need a click (`GraphInspector`). No daily-vs-wiki toggle (folder select approximates it).
- **Proposal**: count non-default filters on the `graph-drawer-toggle`; 300 ms hover card from `adjacency.meta` (stem, type, confidence, cites, degree — no fetch); a "Daily notes" toggle = folder `daily/`. — impact medium · effort S

### 10. Home = greeting + one "Ask or Capture…" input (Tana Today)
- **Seen**: "Good Morning, Alex Smith"; one input "Ask or Capture…" with @/image/mic icons and mode chips Meet / Create / Search; sections Next Up, Past, Pinned, Chats. https://mobbin.com/screens/4297e674-95c8-4646-afe9-96cc77cd4635 · https://mobbin.com/screens/ad6644fa-6e1f-45a3-acee-0a22a27f0f86
- **myco today**: `EverydayHome.tsx` = hero copy + mascot + "Add" button + two large buttons (Ask → route query, Write → `promptNewNote`); no input on Home. Text capture exists only in the notch (`NotchPanel.tsx` S7 `capture` kind) and voice in Spotlight.
- **Proposal**: replace the two buttons with one input: Enter → `setQueryPrefill` + route `query`; "Capture" chip / ⇧Enter → the notch's text-capture path into `_inbox/`; greeting by hour via `Intl`. — impact high · effort M

### 11. Resurfacing as one card with explicit Keep / Forget (mymind Serendipity)
- **Seen**: Serendipity tab blurs the grid and shows one card; two round buttons "Forget" / "Keep"; a toast "Out of sight out of mind — this item is now in your mind trash… restore" with 30-day auto-clear. https://mobbin.com/screens/0361886a-4368-4f6b-9a75-104fee349d49 · https://mobbin.com/screens/ac139799-4d98-46da-8d90-566b770baf84 · https://mobbin.com/screens/5b7e6659-d19e-4384-b168-1cce287a929c
- **myco today**: `stores/resurfaceStore.ts` has picks (cap 2), 7-day snooze, ignore set and a self-tuning floor fed by accepts; `MorningBand.tsx` "Today's reunions" (l.300-334) renders ONE pick as a clickable `RailRow` (stem + snippet). No visible snooze/ignore control, so the floor only ever learns from opens.
- **Proposal**: two quiet buttons on the reunion row — "Keep" (open) and "Later" (store.snooze) — "Later" advances to the next pick; no new state. — impact medium · effort S

### 12. Note actions from the open note: Pin / Trash / Share / History (Reflect)
- **Seen**: right rail "Note actions": Pin this note, Move to trash, Share with private link, Show history. https://mobbin.com/screens/9d0db79a-cef1-4b10-b7c6-a06ba916c0d6 · https://mobbin.com/screens/5ec1a04a-17e2-48da-8a8f-f46bf5ede19c
- **myco today**: `PageReader.tsx` header (l.750-848): Write/Read segmented, Rail toggle, More = Source / Authorship / Make cards / Audio overview. Favorite, Rename, Move to…, Delete exist only in the sidebar context menu (`SidebarMenu.tsx` l.154-196).
- **Proposal**: add Favorite · Rename · Move to… · Delete to the reader More menu reusing `SidebarMenu`'s handlers (they take a node path). — impact medium · effort S

### 13. Per-note version history with "Restore to new note" (Reflect)
- **Seen**: "Show history" opens a split: rendered past version left, commit list right (02:39 PM Commit #79 …), "Restore to new note" primary + Cancel; restored note titled "Restored: Fri, May 5th, 2023". https://mobbin.com/screens/afab6b59-61b6-4316-9383-871ce7a238c6 · https://mobbin.com/screens/3f8480d7-fc91-4330-9c0c-e788e7d1f37b
- **myco today**: `PageHistory.tsx` is the vault's distill/ingest run log with `DiffView` and run-undo; the reader's "See it in history" (`rd_auth_history`) routes there. No per-note version list or restore (grep `restore|revision|snapshot`: only Feedback quarantine restore). Git is opt-in (roadmap).
- **Proposal**: when the vault has git (`VaultHistoryBanner` status), add "History" to the reader More menu → panel of `git log -- <file>` with "Restore as new note" (`<name> (restored <date>).md`, never overwrite). — impact medium · effort L

### 14. Filterable full keyboard-shortcut sheet (Reflect)
- **Seen**: full-screen sheet, "Filter shortcuts…" input, three columns Core / Navigation / Editing, ~35 bindings. https://mobbin.com/screens/cf75fb3f-3929-4e00-9170-c2d324372eaa
- **myco today**: `HelpWidget.tsx` lists 10 global + 2 graph keys in a small floating panel, no filter; its own comment says the app registers far more (⌘E Write↔Read, Mod-/ block menu, `/` slash, ⌘click links are documented only in code/panels).
- **Proposal**: `?` (or ⌘/) overlay grouped Global / Editor / Graph with a filter input; single `lib/shortcuts.ts` table feeding both HelpWidget and the sheet. — impact medium · effort S

### 15. Slash-menu "AI palette" → for myco, "Ask wiki" extractive slash item (Reflect)
- **Seen**: `/` menu ends with Backlink, AI Palette, Now, and record templates (company/journal/person); AI Palette shows "Ask anything to AI…" + a System list (Write the next paragraph, List key takeaways, Fix spelling, Short summary…); result popover has Re-run / Stop, Submit ⌘⏎. https://mobbin.com/screens/e4e55fde-b946-4650-9ade-ce8c4e972567 · https://mobbin.com/screens/2626bdbb-5b87-41c8-8472-2598621ecc34 · https://mobbin.com/screens/97481cc8-faa7-4e00-a0b5-76f429fca091
- **myco today**: `lib/editorCompletions.ts slashItems`: h1–h4, lists, todo, quote, callout, toggle, table, divider, code, link, recall, onthisday, date. No AI entry; `Editor.tsx` has no AI hook. Generative rewriting conflicts with "never invented", but the extractive analogue is missing.
- **Proposal**: slash item `Ask wiki` — takes the current line/selection as the question, runs `queryStore.ask`, inserts the top verbatim quote + `[[stem]]` (same insertion path as `/recall`). No generation. — impact medium · effort M

### 16. Inline empty-state hints for sidebar groups (Craft) + dismissable inspiration cards (Evernote)
- **Seen**: Craft sidebar keeps "Starred — Star Docs to keep them close" and "Tags — Pin your key tags for quick access" as muted lines when empty; Evernote home shows three dismissable "Inspiration for your next note" cards and a "Recently captured" empty state with a "Clip web content" CTA. https://mobbin.com/screens/8a81f01a-8766-4439-8d92-9ccc67dd4a4c · https://mobbin.com/flows/f770979f-3f4e-4d5b-9136-b604c40b7962 (screen 5: https://mobbin.com/screens/a8f7b17d-e559-4a45-b643-3fde3209695b)
- **myco today**: `Sidebar.tsx` l.161-167 pushes the Favorites group only when `favPaths.length > 0`, so a new user never sees that favorites exist; Recently edited is always shown.
- **Proposal**: always render Favorites; when empty, one muted row "Right-click a note → Add to favorites" (string `sb_fav_add` exists). — impact low · effort S

### 17. All-notes table with type tabs, tag filters and Updated column (Reflect All notes)
- **Seen**: table Subject / Snippet / Tags / Updated, sorted by updated; tabs All / Books / Links / People / Trash / Custom; Custom opens a tag-chip filter with counts and confirm-delete. https://mobbin.com/screens/bd8629a7-6837-4237-aed9-8a7c0361f3dc · https://mobbin.com/screens/6265c172-d67b-49e8-b761-3224e7705a48
- **myco today**: no cross-vault list view; only the sidebar tree and `CommandBar` lenses (`BUILTIN_LENSES`: no sources / orphans / disputed / recent, l.23-27). `lib/queryViews.runView/facetValues` already compute such lists for `OverviewBoard`.
- **Proposal**: "Pages" route = `runView` results as a table (name · first line · tags · mtime), lens tabs from `BUILTIN_LENSES`, tag chips from `facetValues`, sortable by mtime. — impact medium · effort M

### 18. Scope the question to a page/folder from the composer (`@` mention, source checkboxes)
- **Seen**: Notion's composer "+" opens a Pages/Users picker to attach a page as context; Gemini Notebook's Sources rail has per-source checkboxes + "Select all" controlling the answer pool; Fabric shows "Current file". https://mobbin.com/screens/ec1eddc9-37e7-45d3-bf7a-cbb30ab6b38b · https://mobbin.com/screens/05def46a-970f-46b2-8bf0-e0e83c7dd49e · https://mobbin.com/screens/b392bc22-bf75-4b35-be0a-ae58de609dc2
- **myco today**: `PageQuery` scope = wiki / sessions / all (`AskScope`); `SourceLadder` tier sliders re-rank after the fact; `lib/searchQuery.parseSearchQuery` already understands `path:` and `tag:` but the Ask composer exposes neither.
- **Proposal**: `@` in the ask input opens the CommandBar page list; picking adds a `path:` chip that the retrieval honours (reuse `hitPassesFilters`). — impact medium · effort M

### 19. Abstain → "Add a source now" (ManyChat, Perplexity)
- **Seen**: ManyChat: "This topic isn't in your knowledge base yet — Add a source so AI can handle questions like this: [Add link] [Add text]"; Perplexity explains exactly what's not connected and how to fix it. https://mobbin.com/screens/84688996-8fd9-48cc-b697-fc85c8a3f9b3 · https://mobbin.com/screens/22751952-1a5e-43a0-8212-1e5cf08092eb
- **myco today**: `AbstainCard.tsx` — stop orb, near-miss gauge rows, buttons "record as harvest target" and "widen scope". No direct path to Ingest.
- **Proposal**: third button "Add a source" → `setRoute("ingest")` with the question carried as the pending harvest label (`harvestStore`). — impact low · effort S

### 20. Daily note from a template (Evernote onboarding "Enable Daily Notes")
- **Seen**: onboarding step lets the user pick the daily-note template (Journal / To-do list / Agenda) before the first one is created. https://mobbin.com/flows/f770979f-3f4e-4d5b-9136-b604c40b7962 (screen 2: https://mobbin.com/screens/8a724040-c201-44f8-971e-c5cc6989cf88)
- **myco today**: `DailyNoteButton` writes `# <date>\n\n` (l.566-568); `TemplatePicker.newNoteFromTemplate` and a `templates/` folder exist for ordinary notes but the daily note ignores them.
- **Proposal**: if `templates/daily.md` exists, seed the daily note from it (date substituted); Settings gets a one-line "Daily note template" row. — impact low · effort S

### 21. Whiteboard / canvas (Heptabase) — not on Mobbin; do not build
- **Seen (closest)**: Tana canvas — free cards, arrows, sticky notes, a Backlinks rail ("Mentioned in") beside the board; Craft whiteboard — "Find on canvas ⌘F", "Zoom to fit", canvas background swatches. https://mobbin.com/screens/5c07ccc0-d0d3-459f-8e24-b76eff94f60e · https://mobbin.com/screens/66b19439-76a3-4493-8e8a-38d95b154645
- **myco today**: `PageGraph.tsx` force graph with looks, static-layout drag (`createStaticDrag`), fit, `GraphInspector` with links/backlinks/path. No manual canvas.
- **Proposal**: skip a canvas (YAGNI for a wiki whose structure is links). Only borrow the two affordances the graph lacks as visible controls: "Zoom to fit" and "Find on graph ⌘F" buttons in the graph toolbar (search exists but is buried in the Filters drawer). — impact low · effort S
