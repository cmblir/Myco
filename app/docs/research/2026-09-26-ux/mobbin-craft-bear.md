# Mobbin research — Craft & Bear → myco

Key: `craft-bear`. Platform: Craft web (Bear is iOS-only on Mobbin; every Bear
screen below is iOS). 16 searches, every image inspected. myco claims are checked
against `~/prj/karpathy-editor-build/app/src` (the installed tree).

Not on Mobbin (searched, honest misses): Craft inline formatting toolbar (got
Kajabi / Confluence / mymind instead), Craft onboarding flow (got Mintlify /
GitBook / Fibery), Bear `[[` autocomplete (got Craft iOS @-mention, Notion link
sheet). Neither app has a graph view — no graph findings from this family.

## What was actually on the screens

**Craft — All Docs home** ([e561d971](https://mobbin.com/screens/e561d971-2223-4782-9010-b1852bae42f2), [5bd9cb88](https://mobbin.com/screens/5bd9cb88-2ff4-4175-afe6-8ef719e3a80d), [3129ea1e](https://mobbin.com/screens/3129ea1e-b5a7-41ca-88b7-c5830215e312))
Left sidebar: space switcher, "New Document", All Docs / Tasks / Calendar, then
Imagine / Shared With Me (badge) / My Templates; sections **Starred**, **Folders**
(emoji-iconed rows, one expanded to show sub-docs), **Tags** (#holiday, #travel).
Main: "All Docs" + a "+" circle; a grid of document cards, each = title, meta line
(folder icon · folder name · "Updated 17 hours ago"), and a *rendered miniature of
the body* (text lines, small images, cover photo when set). The daily note
("Yesterday, Tue, Apr 7") is the first card, carries a calendar icon and a darker
border. Centre-top search bar labelled "Open". Bottom-right floating "Assistant"
pill. In the empty account, Starred shows "Star Docs to keep them close" and Tags
shows "Pin your key tags for quick access" in italic grey instead of vanishing.
"+" opens a two-row popover: "New Doc — Start something new" / "From Template —
Save time with templates" ([f62afdea](https://mobbin.com/screens/f62afdea-6f6b-47f5-a1b6-0f90d3b1b019)).
Folders view ([0013c292](https://mobbin.com/screens/0013c292-428b-41ae-9a1c-39cfc5d8e204)):
folder cards with icon, name, "2 Documents".

**Craft — editor** ([74635ca6](https://mobbin.com/screens/74635ca6-9e08-4cd5-823d-f566cd54d7eb), [352c903f](https://mobbin.com/screens/352c903f-ce30-46ca-b067-19ab0e4c9790), [a7a36fac](https://mobbin.com/screens/a7a36fac-8b21-4a22-9af0-c8c9eb7f4d29), [412890bd](https://mobbin.com/screens/412890bd-d053-4681-814e-0e2b8f2146cf), [42753a8f](https://mobbin.com/screens/42753a8f-a3c9-4249-9c78-43fd4a9c8019))
Left panel "Table of Contents": headings plus nested sub-pages with expand
arrows; the panel has four icon tabs (TOC, tasks, attachments, search). Body:
"Day 1 : Arrival in Tokyo" as an italic serif H2, a bold inline label "Theme:"
followed by regular text, bullets, a hairline rule between sections, uniform
~8px rhythm. A focused heading block gets a soft light-blue background across the
full line. A collapsed toggle "How to use this template" sits in a grey rounded
box. Code block is a dark canvas with grey line numbers, rounded corners, big
padding — on a light page. Document style: cover photo, purple serif title, an
inline monospace yellow highlight; a blurred photo backdrop behind the page card.
Right rail tabs Insert / Format / Style / Info.

**Craft — Info tab** ([a5110fb6](https://mobbin.com/screens/a5110fb6-ce5e-4bee-90ea-7fcd69790899), [2eed49ad](https://mobbin.com/screens/2eed49ad-a75e-4ea2-9bc8-782c14bdee2d), [8bc2c4e6](https://mobbin.com/screens/8bc2c4e6-34cd-4478-900c-b0c0c8f8da3f))
"Page Info | Actions" segmented. PROPERTIES: Created 9 hours ago · Updated 1
hour ago · Author. DOCUMENT REVIEW (NEW): four circle-checkbox rows "Check
Grammar and Spelling / Get Feedback on Structure / Check Tone of Voice / Ensure
Clarity". ACTIONS: Present, Move To…, Duplicate, Star/Unstar, View Backups,
Delete (red). LOCATION: Unsorted. STATS · THIS PAGE: Words. Under the title a
meta line "avatar · 1 comment · 5 hours ago"; breadcrumb "Templates / Trip Plan…"
top-centre. Toasts bottom-right: bold title + grey subline ("Starred — Trip
Plan…", "Moved to Templates — 1 item").

**Craft — Style tab / page options** ([1476bad6](https://mobbin.com/screens/1476bad6-e33a-43bc-8b8b-b96491e4c1df), [a51300aa](https://mobbin.com/screens/a51300aa-cb49-4d5b-ba5d-acef38d5f371))
Style Gallery modal: YOUR STYLES + CRAFT'S STYLES, each a preview card showing
the title in that style's face. Rail: COLOR (Backdrop / Document / Text), COVER,
SEPARATOR STYLE (Washi Tape, Pattern), FONT segmented (Aa · Ss Serif · 00 ·
mono), ADVANCED: Wide Page toggle. Advanced Options: toggles each with a helper
sentence (Show TOC, Show Title, Show Author, …).

**Craft — settings** ([174f0fb5](https://mobbin.com/screens/174f0fb5-a3db-4e39-b175-2ab8726f8c10), [064a9565](https://mobbin.com/screens/064a9565-25f0-4641-ba64-110ad27d358f))
Modal with a left nav (Space Settings / General Settings / account). Appearance =
three thumbnails System / Light / Dark showing the actual doc rendered, selected
one ringed blue. Notifications: section title + helper text + toggle rows.

**Craft — search "Open"** ([d370247f](https://mobbin.com/screens/d370247f-a6ec-4e59-a67e-ddf2aa9aae8c))
Dropdown under the bar: "Earlier" (the previous query "how"), then "Documents"
rows = doc icon (with a coloured badge), title, subtitle "In My Space".
Craft iOS @-mention ([446d6fa2](https://mobbin.com/screens/446d6fa2-b15a-4050-a3a1-ca753efef80e)):
groups IN THIS DOCUMENT / BLOCKS; every result has a breadcrumb line
("Craft Handbook 📖 → Inserting Whiteboa…").

**Craft — calendar** ([c0e34ca5](https://mobbin.com/screens/c0e34ca5-a9e3-4eda-a15f-03b549cdccdf), ja locale)
Vertical day strip: each row a tile "4月7日 / 今日 / 火曜日" (today tinted blue),
to its right a small daily-note card ("今日", body excerpt) and that day's tasks
with a checkbox, due chip and a source-document chip ("Travel itinerary").
Empty days = tile only. "↑ 前の日を表示" at top, "完了したタスクを表示" at bottom.

**Bear — sidebar / tags** ([192baa1d](https://mobbin.com/screens/192baa1d-4e66-488f-9f45-8d9d61ecb072), [400db6af](https://mobbin.com/screens/400db6af-61d4-4a29-9eb6-e68f3c32cc90))
Dark sidebar: Notes ›, Trash, then tags with custom icons ("europe travels" with
an airplane icon and a pin marker, "bear" with a chevron = nested). "Edit Tag"
sheet: icon dropdown + name field. Floating filter/sort round button.

**Bear — editor** ([f42a17c8](https://mobbin.com/screens/f42a17c8-2928-4329-9cd0-a83e58bc72e1), [ef6ca3d8](https://mobbin.com/screens/ef6ca3d8-7e5d-4864-8ee8-49465280b718), [5a4a1703](https://mobbin.com/screens/5a4a1703-2d5b-4342-b265-dae607e4d776), [3546b259](https://mobbin.com/screens/3546b259-8197-41ef-88b4-4ce5e4d0208a), [900799ed](https://mobbin.com/screens/900799ed-296a-4faf-b951-cf7a686dd71e))
Title in large bold, tag as a grey pill "#Travel", date. Keyboard bar: undo /
redo / # / hide-keyboard / ⋮-outline / ABC; a button grid: indent-outdent,
camera, sketch, table, calendar, line-spacing; H1 (popover H1–H4, H2 selected in
red), B, I, U, S; list, highlighter, `</>`, link, ⌫; checkbox, align, superscript,
space, return. Selected text reveals its markdown marks (`***_`, `==`) in grey at
the span edges; a highlight renders as green-yellow with underline. Headings
popover (from the ⋮ icon) lists Heading 1–5 with a check.

**Bear — info / backlinks / stats** ([9e6cad2e](https://mobbin.com/screens/9e6cad2e-5927-42dc-8bde-3e4b90a2e0db), [4001e769](https://mobbin.com/screens/4001e769-108c-4748-8df1-7edb4fc9002b), [f0e518f4](https://mobbin.com/screens/f0e518f4-2b56-437a-b9d9-a5382b49b23b), [364ba2b1](https://mobbin.com/screens/364ba2b1-f2e3-4e6e-9fa9-88cb3be3fb71), [dafbe628](https://mobbin.com/screens/dafbe628-b5b7-4918-9711-4b5ea68a85f4))
Bottom sheet with a segmented control (stats | outline | backlinks). Backlinks:
"Welcome to Bear 👋" row with an expand chevron; empty state = centred grey "No
Backlinks". Statistics: 2×2 tiles 114 Words / 786 Characters / 21 Paragraphs /
27s Read Time, then Modification Date / Creation Date rows. In the note, a pill
"786 Characters ▾" toggles Words / Characters / Paragraphs / Read Time / Hide
Stats. Table: tinted header row, hairline borders, wrapped cells. Nested tag
pills "#Europe Travels/france#".

**Bear — settings** ([95e7ed37](https://mobbin.com/screens/95e7ed37-cb15-47af-9ccb-610207ec6d3c), [354bc14e](https://mobbin.com/screens/354bc14e-6017-4d2e-9d01-3f5085374c14), [43d513b2](https://mobbin.com/screens/43d513b2-115b-4c6f-95d3-8d1bce91fc21), [97885e25](https://mobbin.com/screens/97885e25-0429-43b4-98ac-b9df592b7ff7))
Typography: Text / Headings / Code font rows, FONT SIZE slider (16 pt), Line
Height 1.5 em, Line Width 48 em, Paragraph Spacing, Paragraph Indent as −/+
steppers, helper "…are all based on the font size", red "Restore Defaults", a
live "Bears" preview below. Font list is alphabetical with each family rendered
in its own face. Themes: "Select a theme for each system appearance: ☀ Light and
☾ Dark"; each theme is a card of real sample text showing bold, coloured link,
underline, `code` and highlight in that palette (Red Graphite, Dark Graphite,
High Contrast, Rosé Pine Dawn, Tokyo Night, Academia).

**Bear — notes list** ([595f016f](https://mobbin.com/screens/595f016f-bcb8-469f-81e7-6a043d3c9f53), [9a28a181](https://mobbin.com/screens/9a28a181-bb39-4ab4-8b09-8c906835cf5a), [641f6455](https://mobbin.com/screens/641f6455-f244-4387-8880-3cdf9aad1748), [c8fea37b](https://mobbin.com/screens/c8fea37b-8da6-48a5-9d9e-3b73bb5b1fe1))
Rows: bold title, two-line excerpt (tags inline), three image thumbnails,
"A minute ago" with a red pin glyph when pinned. A fresh install ships four
welcome notes so the list is never empty. List menu: "5 notes", Notes List
Sorting, Preview Style (Small / Medium / Large ✓), Hide Attachments, Hide Subtag
Notes, Export…, Select Notes. Search highlights every hit in yellow inside title
and snippet. Swipe: pin / trash.

**Other apps that answered a Craft/Bear query**: mymind markdown cheat-sheet
panel ([4df2e914](https://mobbin.com/screens/4df2e914-3742-4b59-bda4-a52ed23ee990):
Heading `#`, Bold `**text**` or ⌘B, Highlight `==…==`, ToDo `[x]`, Code ``` +
Space, Inline `` `text` ``, Strike `~~`, Divider `---`); Confluence text-style
menu with ⌘⌥0–6 ([622c0046](https://mobbin.com/screens/622c0046-0e05-4564-9ab2-347221d928cc));
Evernote palette footer "↵ Select · ⌘↵ Open · ⌘L Copy Link" and Standard |
AI-Powered toggle ([3120a6eb](https://mobbin.com/screens/3120a6eb-313c-492d-96f2-63b5656c80be));
Coda "In this doc | All docs" search scope ([9d2e6129](https://mobbin.com/screens/9d2e6129-e275-4386-8da0-d4b4fe0bd89d));
Fabric assistant chips "Summarize / List points / Explain like I'm five"
([180b0393](https://mobbin.com/screens/180b0393-b103-4f6e-8afe-8e9a785c25b7)).

## Patterns → myco gaps → proposals

| # | Surface | Pattern (app) | myco today (file) | Proposal | Impact / Effort |
|---|---|---|---|---|---|
| 1 | home | Recent docs as cards with a rendered body excerpt, folder crumb, "Updated 17h ago"; daily note first with calendar icon (Craft) | `RecentNotes.tsx:37-60` renders `list-row`: page icon + stem + relative day, limit 4 (`PageOverview.tsx:140`). No excerpt, no folder, daily note not distinguished. | `recent-card` grid: first ~200 chars of body (one `ipc.readFile` per row, 4–6 rows), vault-relative folder, relative time; today's `daily/<date>.md` pinned first with a calendar icon. | high / M |
| 2 | empty_state | Empty sidebar sections keep their header and say what will appear ("Star Docs to keep them close") (Craft) | `Sidebar.tsx:165` pushes the Favorites group only when `favPaths.length > 0`, so the star affordance is invisible until used; empty vault is the bare string `sb_empty_vault` ("빈 볼트"). | Always render Favorites/Recent headers; under an empty one show a one-line hint (`sb_favorites_hint`, `sb_recent_hint`). Replace "빈 볼트" with hint + inline "새 노트" button (reuse `NewPageButton`). | medium / S |
| 3 | sidebar | "+" is a two-row popover: New Doc / From Template with sublines (Craft) | `NewPageButton` (`Sidebar.tsx:520-541`) calls `promptNewNote` directly; template creation exists only as a ⌘K action (`CommandBar.tsx:169-173`, `TemplatePicker`). | `NewPageButton` opens a two-row menu (new note / from template…) using `SidebarMenu`'s `.myco-menu` styling. | medium / S |
| 4 | sidebar | A **Tags** section in the sidebar; tags are first-class nav (Craft, Bear) | Sidebar has Workspace / Tools / Pages only (`Sidebar.tsx:285-444`); `adjacency.tags` already exists and drives the `tag:` operator (`CommandBar.tsx:103`). | Collapsed "Tags" `nav-group` listing top-N tags by count; click opens ⌘K with `tag:<name>` prefilled (`setCmdOpen` + initial query). No new route. | medium / S |
| 5 | search | Palette rows carry location ("In My Space", "Craft Handbook → Inserting…") and an "Earlier" recent-queries group (Craft web + iOS) | `CommandBar.tsx:372-393` rows show label + a type chip ("file"); no folder; same-stem files in `wiki/` vs `sessions/` are indistinguishable; no recent queries. | Add `.cmd-path` (vault-relative parent folder) under page rows; keep last 5 queries in `uiStore` (persisted) and show them as "Earlier" when `q` is empty. | high / S |
| 6 | search | Footer key legend (↵ Select · ⌘↵ Open) and "In this doc / All docs" scope (Evernote, Coda — Craft has neither) | Footer is one sentence of hint text (`CommandBar.tsx:466-473`); content hits always vault-wide. | `kbd` legend row (↵ open · ⌥↵ log miss · esc); when `route` is `page:`, a toggle chip "이 노트에서" filters `contentHits` by that path. | medium / S |
| 7 | editor | Formatting keys B/I/U/S + H1–H4 popover; ⌘⌥1–6 text styles; a markdown cheat-sheet panel (Bear, Confluence, mymind) | `Editor.tsx:163` registers only `Mod-s`; no `Mod-b`/`Mod-i` anywhere in `lib/editorMarks.ts`, `lib/editorLive.ts`, `lib/editorBlockOps.ts`; `BlockMenu` is block-level only ("Turn into" / "Actions", `BlockMenu.tsx:112-113`); `HelpWidget.tsx:63-77` lists no formatting keys. | Keymap `Mod-b`/`Mod-i`/`Mod-e`/`Mod-k`/`Mod-Shift-h` wrapping the selection (`**`, `*`, `` ` ``, `[[`, `==`) via existing mark helpers; add a "Markdown" block to `HelpWidget` with the mymind-style table. | high / S |
| 8 | editor | Callout / toggle is a tinted rounded card distinct from a quote (Craft) | Slash menu inserts `> [!note] ` (`lib/editorCompletions.ts:161`), but no `callout` selector exists in `styles.css` or `styles/*.css`; the line inherits `.live-quote` (`styles.css:3115`, 3px border, ink-3), so a callout looks identical to a quotation and its kind is not shown. | Line decoration `live-callout live-callout--<kind>` when a quote's first line matches `[!kind]`; CSS: `background: color-mix(in srgb, var(--c-<kind>) 8%, var(--bg))`, radius `--r-md`, icon + bold kind label; same rule for `.prose blockquote.callout`. | high / M |
| 9 | editor | Code block = dark canvas, line numbers, big padding, rounded, on a light page; language label (Craft, Loop) | `.prose pre` gets only `overflow-x` (`styles.css:1376`); `.live-code` gets `bg-soft` + mono (`styles.css:3104`). No padding, radius, language label. | `.prose pre, .live-code-block { background: var(--bg-inverse); color: var(--bg); padding: 14px 16px; border-radius: var(--r-md) }` + fence info string as a top-right label. Skip line numbers. | medium / S |
| 10 | editor | Focused block gets a soft full-line tint; sections have uniform spacing and hairline separators (Craft) | Live headings only set size/weight (`styles.css:3104-3120`) while Preview headings carry margins (`styles.css:1382-1400`: h2 `28px 0 8px`) — Live and Preview differ in vertical rhythm; `.cm-activeLine` has no rule. | Add line-class decorations for heading lines so Live gets `padding-top` matching Preview margins; `.myco-editor.live .cm-activeLine { background: var(--bg-elev) }`. | medium / S |
| 11 | editor | Note stats: Words / Characters / Paragraphs / Read Time tiles + Modification/Creation dates; in-note "786 Characters ▾" pill (Bear) | No `wordCount` / `readTime` / `charCount` anywhere in `lib`, `components`, `pages`; reader header shows path, save status and authorship badge only (`PageReader.tsx:700-749`), no dates. | "Note info" `Rail` at the top of `ReaderRail.tsx`: words · read time (words/220) · updated (mtime via `ipc.fileMtimes`, already used by `Sidebar.tsx:129`) · created from frontmatter when present. | medium / S |
| 12 | editor | Backlinks list with an explicit "No Backlinks" state and expandable context per backlink (Bear) | `ConnectionsPanel.tsx:145-200` merges backlink / related / suggested into one list distinguished only by a chip; a backlink row shows the name, never the sentence that links here; the count in the rail header sums all three kinds. | Keep one Rail, but group by kind with sub-headers and counts ("백링크 3 · 관련 5 · 제안 2"); under each backlink show the linking line (`ipc.searchVault('[[stem]]')` already returns `line` + `snippet`). | high / M |
| 13 | editor | Location shown as a breadcrumb ("Templates / Trip Plan…") and as a LOCATION row; actions grouped in one Info tab (Craft) | Location is the absolute path in 12.5px muted text (`PageReader.tsx:701-714`); actions split between the `rd-more` overflow (`PageReader.tsx:776+`) and the sidebar context menu (`SidebarMenu.tsx`). | Replace the path string with a vault-relative breadcrumb; each crumb calls `toggleFolder` + scrolls the sidebar row into view; keep the absolute path in `title`. | medium / S |
| 14 | editor | TOC panel highlights the section in view; toggle Document / Folders view (Craft) | `OutlinePanel.tsx:17-38` is a static list of heading buttons with no current-section state. | Track the visible heading (Preview: `IntersectionObserver` on rendered `h1–h3`; Live: `view.lineBlockAtHeight(scrollTop)` → nearest heading line) and set `aria-current` on that outline item. | medium / M |
| 15 | settings | Typography controls: font size slider, line height, line width in em, live preview, Restore Defaults (Bear); Font Aa/Serif/Mono + Wide Page (Craft) | `uiStore.ts:126-129` holds theme / density / accent only; Appearance tab (`PageSettings.tsx:361-368`) offers theme, overview skin, tray, notch, Spotlight shortcut — no reading size or width; `.prose` is hard-coded 17px/1.7/720px (`styles.css:1364-1367`), Live 17px/1.75 (`styles.css:8361-8365`). | Two controls: reading size (15 / 17 / 19) and reading width (640 / 720 / 860) → `--read-fs`, `--read-w` on `:root`; both `.prose` and `.myco-editor.live .cm-content` read them so Live and Preview cannot drift. | medium / S |
| 16 | settings | Theme choice as rendered previews (Craft thumbnails; Bear sample cards showing bold / link / code / highlight per theme) | `pages/settings/Appearance.tsx:33-69` renders theme options as icon+label buttons — no sample of prose, link, code or highlight under each theme. | Make each option a mini card: 3 lines of sample text with a `.wikilink`, inline `code` and a `==mark==` drawn with that theme's tokens (`data-theme` scoped). | low / S |
| 17 | other | Calendar as a vertical day strip: date tile + that day's note card + tasks due with a source-doc chip; empty days are just a tile (Craft) | Daily note is one sidebar button creating `daily/<date>.md` with only `# date` (`Sidebar.tsx:543-590`); `TaskCalendar.tsx` shows tasks, but daily notes have no timeline and no prev/next navigation. | In the Reader header, when the file is under `daily/`, add ‹ prev day · next day › buttons; in Tasks calendar, list `daily/*.md` per day with a first-line excerpt beside that day's tasks. | medium / M |
| 18 | empty_state | Fresh install ships welcome notes so the list is never empty; rows show excerpt + thumbnails (Bear) | After the 5-step wizard (`lib/onboarding.ts:12`) an empty vault shows "빈 볼트" in the sidebar and `ov_recent_never` on Home; no starter page. | On wizard finish with zero pages, write `wiki/myco 시작하기.md` from `templates/` (reuse `newNoteFromTemplate`) showing `[[링크]]`, `> [!note]`, a citation and "Ask에서 물어보기". | medium / S |
| 19 | ai | Per-document review checklist in the Info tab (Grammar / Structure / Tone / Clarity) and assistant chips on the note (Craft, Fabric) | Note-quality signals surface on Home (`MorningBand.tsx:200-230` Suspect pages / Contradictions rails), not on the note being read; the reader rail has Sources and Connections only (`ReaderRail.tsx:41-55`). | "이 노트 점검" Rail with three rows — 인용 lint, 모순 확인, 링크 제안 — each running the existing function (`lintStore`, contradictions, `suggestLinks`) and showing ✓ / a count; results link to the line. | medium / M |
| 20 | consistency | Toasts = bold title + grey subline; a hint sentence under every settings toggle (Craft) | `notice.ok/warn` already supports `sub` (`ConnectionsPanel.tsx:112-124`); Appearance toggles (`PageSettings.tsx:363-367`) — helper text not verified per row. | No toast change. Audit settings rows so every toggle carries a one-line "what changes" helper, Craft-style. | low / S |

Verified positives worth keeping: Live and Preview share one heading scale
(30/22/17 in both `styles.css:1382-1400` and `3104-3120`); the sidebar folder
count badge (`SidebarTree.tsx:95`) already does what Craft's "2 Documents" does;
`RecentNotes` uses `Intl.RelativeTimeFormat` like Craft's "Updated 17 hours ago".

Not verified in this pass: whether the Live table widget from the newer branch
(commits 46cc8f3 / da4d5f7 in the dev repo) is in the installed tree — no
`.prose th` / `td` or `live-table` rule exists in the installed `styles.css`.
