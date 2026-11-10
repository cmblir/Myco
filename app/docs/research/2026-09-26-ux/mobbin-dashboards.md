# Mobbin research — dashboards (home screens for a personal knowledge base)

Key: `dashboards`. Date: 2026-09-26. Source tree read: `~/prj/karpathy-editor-build/app/src` (installed build).

## What myco's home is today (verified in code)

- `pages/PageOverview.tsx` renders, in "simple" mode (default): `EverydayHome` (static tagline hero + mascot 170px + one "Add" button → ingest, then two 6rem action tiles "Ask" → route `query`, "Write" → `promptNewNote`), then `RecentNotes` (4 mtime-sorted rows: stem + relative day), then a full-width "Manage" disclosure whose count is `harvestCount + pendingProposals`.
- Everything else — `VaultPulse` figures, `HarvestQueue`, `LinkSuggestions`, `OverviewBoard`, `DistillCard`, `ReflectPanel`, and the four Morning panels (`since`, `suspect`, `contradictions`, `reunions` = top resurface pick + FSRS due) — mounts only after the user opens Manage (`shouldMountManagement`, lines 63, 179-181, 209). `styles/everyday.css:231-235` hides the right rail in simple mode.
- Copy comes from `lib/everydayCopy.ts` (`home_title` "A little space for everything you learn." / "기억하고 싶은 것들을 한곳에."). No greeting, no date.
- Daily note: `components/Sidebar.tsx:543-590` `DailyNoteButton` ("Today's note", creates `daily/YYYY-MM-DD.md`). Not on the home.
- Last opened page: `stores/uiStore.ts:86,211,326` keeps a persisted `navHistory`; `pages/PageReader.tsx` has no scroll save/restore (no `scrollTop`/`restoreScroll` matches). The home never surfaces either.
- Counts: `Sidebar.tsx:297` badges harvest candidates on the Overview row, `:318` pending proposals on Harvest box, `:374` due cards on Study. `_inbox/` source count appears in no chrome component (only in store comments).
- Ask: `EverydayHome.tsx:50-63` the Ask tile only navigates. Example questions live only in `pages/PageQuery.tsx:415-430` (`copy.examples`). Voice capture exists only in `components/Spotlight.tsx` (⌥M).
- Customization: two systems — `components/OverviewArrange.tsx` (grip drag, spans 1/3 1/2 full, keyboard arrows, reset) and `components/OverviewBoard.tsx` (react-grid-layout, presets via `<select>` + "Add widget", `window.prompt` for a new board at :393, `window.confirm` delete at :416). Arrange is reachable only inside Manage (`PageOverview.tsx:211-221`).

## Screens looked at (what is actually on them)

### Notion (web) — database "Dashboard" view, not a Home tab
- https://mobbin.com/screens/41f32a46-0aa4-4205-a6ab-627135308029 — Sidebar: Home row, then **Recents** (5 pages, emoji icons, grey type pills "Meeting instructions"), Favorites, Agents, Private, Teamspaces; bottom "New chat ⌘O" pill. Main: "Team" page, view tabs "Table | Dashboard", blue **Done** button (edit mode). Dashboard is a 2-col grid of bordered cards, each with a tiny blue label ("Chart", "Timeline", "Table") and filter/sort icons top-right: donut "4 Total" with % legend, April 2026 timeline with red today marker, full-width line chart, table.
- https://mobbin.com/screens/bb44b319-bbfe-4dd7-a199-dcc3d6143fe5 — hover tooltip on the donut: "Full-time 2 (50%) · Click to view data".
- https://mobbin.com/screens/2a3c9ede-fa76-4e52-8b0d-b1ae025ec0c6 — empty dashboard: one dashed card with five grey view icons and a "+ New view" chip.
- https://mobbin.com/screens/0b94c9f8-5d71-4d6b-9058-74bf3e9f0b18 — "New view" popover listing Table/Board/Gallery/List/Chart/Timeline/Feed/Map/Calendar.
- Notion's web **Home** tab is not captured on Mobbin; the iOS Home is:
- https://mobbin.com/screens/d120561c-525c-42e5-a177-c5bfa948a721 (iOS) — top pills (avatar, Home, chat, calendar, inbox); "Recents ⌄" as a horizontal card row (grey cover strip + emoji + title); "Private ⌄" list below; bottom bar = search, **"Ask AI" pill input with mic**, compose.
- https://mobbin.com/screens/635d1b61-bb91-458d-ac98-3dc7497b9436 (iOS) — Inbox tab grouped "Last week", rows with icon + sentence + relative time, red due date.

### Craft (web)
- https://mobbin.com/screens/d7acd3b4-7d9a-49cb-b847-8b93b79bcd3c — top-center "Open" search. "All Docs" card grid, 5 across (~150×180). **First card is "Today, Tue, Apr 7 · Blog · Updated 20 minutes…"** (the daily note, highlighted), second "Fri, Apr 10"; other cards: title, "Updated 42 minutes ago", thumbnail; starred docs carry a star in the corner. Sidebar: New Document, All Docs, Tasks, Calendar, Imagine, Shared With Me (badge 1), Starred, Folders, Tags.
- https://mobbin.com/screens/6cbca1f6-b5e9-4e23-af22-3ab1c01b8b63 — Notifications popover with Activity | Reminders tabs, "IN PROGRESS" group, red "Overdue since Today, 9:00 PM".
- https://mobbin.com/screens/c0e34ca5-a9e3-4eda-a15f-03b549cdccdf — Calendar: left column of day tiles (4月7日 今日 blue), each day shows its daily-note card + tasks inline with an "インボックス" tag.

### Evernote (web + iOS) — the closest thing to an Obsidian dashboard on Mobbin (Obsidian itself is not on Mobbin)
- https://mobbin.com/screens/9e3cfef0-b1b3-45b9-a0a9-f67441275c17 — gradient banner, "Your Home" + pencil icon. Row 1: **Scratch pad** (sticky, 1/3) | **Notes** horizontal card row (notebook, title, 4-line excerpt, "1 min ago"). Row 2: **Recently captured** (Documents ⌄ filter) | **My tasks** checklist (red due dates) | **Tags** chips with counts. Sidebar "Notes 42".
- https://mobbin.com/screens/8a1cf5b7-c30b-419c-b601-280c9cf6b1d9 — "Inspiration for your next note": three dismissible (×) suggestion cards with "Create note" links; "Recently captured — Web clips" empty state = scissors illustration + "Save useful information from the web." + CTA.
- https://mobbin.com/screens/34eac6fa-2f24-40c8-a504-4b779fd8d7b2 — customize mode: blue bar "Customize your Home — Drag widgets where you want them · Cancel · Done"; each widget gets ⊗ and a **Widget Size** 3-pictogram toggle; right panel **Available widgets** with previews (Notebooks, My Tasks, Calendar, Scratch Pad, Pinned Note, Shortcuts, Filtered Notes) + Reset; Background toggle.
- Flows: https://mobbin.com/flows/416cd56e-92e5-46b6-bba7-e10aa67fc125 (Customizing home, 11 screens) and https://mobbin.com/flows/9bdcecae-c81d-4db2-aa29-835d6d8ffd47 (Adding a widget, 4 screens) — a dashed "Drag widgets here" tile appears in the grid; new home has "Ready to start taking notes? Sam's Home" and a **Customize** link top-right; empty widgets each show one CTA ("Create new note", "Add new task", "Select a note to pin").
- https://mobbin.com/screens/2e3f4be4-470e-4c5f-a9f1-2e086ddc574e (iOS) — "My Evernote — Monday, 4 November 2024", search field, "Complete your setup" card, big New note / New task tiles, Event/Notebook/Audio/Camera tiles, Scratch Pad.

### Fabric, Coda, Plane, Elicit, Zoom Docs (web) — recents and greetings
- https://mobbin.com/screens/781bd95a-b259-4e90-9ede-c70ea3024beb (Fabric) — "☀️ Good morning, Sam Lee" + "+"; full-width search "What are you looking for?"; **Get started** checklist (2 of 3 struck through, "Don't show again"); "Recent items ›" 3 cards; "Recent spaces ›"; floating bottom pill (+, search, AI).
- https://mobbin.com/screens/ba6f5461-ff84-4795-b8f6-a11d5a7526a9 (Coda) — "Resources for you" cards with **Hide**; tabs Recent | Trending | My shortcuts | Owned by me | Shared | Mentioned | Deleted; "Sort by viewed"; rows = icon, title, ★, folder pill, **"Last viewed by you today at 6:16 PM"**.
- https://mobbin.com/screens/f965606c-1da8-4182-99e1-ac3baf75ca90 (Plane wiki) — "Good morning, Sam Lee — ☀️ Thursday, Aug 28 03:12"; "Recents" rows (icon, title, "1 minute ago", avatar); "Your stickies" + "Add sticky" green sticky editor.
- https://mobbin.com/screens/85bf0252-6812-4038-bb56-3071de96b776 (Elicit) — "Recent": three "New …" starter cards, All/Created by you/Shared filter, rows with type column + "11:56am today".
- https://mobbin.com/screens/42252960-cd38-424f-bf9d-8d9a0770878f (Zoom Docs) — "Recent" table: Name / Creator / Last viewed ("Just now", "21 hours ago"); action row New document / Create from meetings / Templates / Import.

### Todoist, Things 3 — "Today"
- https://mobbin.com/screens/e80e5692-9bdd-41ac-81df-25e8dd7e104a (Todoist web) — "Today" + "☑ 4 tasks"; collapsible **Overdue** group with right-aligned "Reschedule"; red date chips; divider "9 Feb · Today · Monday"; "+ Add task" inline. Sidebar: Inbox (count), Today (4), Upcoming.
- https://mobbin.com/screens/b169707f-d41c-43b4-bd23-4f06c837294b — timed calendar events as grey bars above the tasks.
- https://mobbin.com/screens/46dab991-e521-44bc-984a-c936e31610a8 — right "Insights" rail: Health (Critical + sparkline + text), At risk, Progress 0%, Completed this-week bars.
- https://mobbin.com/screens/e90634cd-7e0b-4852-9fc6-f57a017276b6 (Things 3 iOS) — "⭐ Today"; grey block of timed events; yellow banner "You have 1 new to-do · OK"; to-dos with project subtitle; "🌙 This Evening"; + FAB.

### Continue where you left off
- https://mobbin.com/screens/54c0aa01-9380-4e13-bc41-01e46dba6812 (Uxcel) — "Continue learning" card: illustration, "COURSE Core UI Components · Current Lesson: The Anatomy of UI Components", 6% bar + "7h left", purple **Resume course**; rail: "2 day streak" week dots.
- https://mobbin.com/screens/558911ab-f326-4158-ab38-8e27a21ca639 (Coursera) — "Continue learning": course, "Course 1 of 7 · 8% complete", next item "Welcome to module 1 · Video (1 minute)" + Resume; "Weekly goal progress tracker" M T W T F S S.
- https://mobbin.com/screens/7bcb3736-9c35-4c45-a615-28c327f4994b (Literal) — "Currently reading · 1 Book" card with "Page 140" and a status popover.

### Resurfacing / on this day (Day One not on Mobbin)
- https://mobbin.com/screens/6b8f4da6-541b-4d57-b9bf-ce108890032c (Dot, iOS) — stacked cards: **"Yesterday"** chronicle with inline linked entities (underlined "ergonomic mouse options", "trip to Bali", "Ulun Danu Beratan Temple") + thumbnails; "Today" card empty; caption "Chronicles are updated every night".
- https://mobbin.com/screens/5e2df1a2-3506-4e63-aa45-939f29de9e4d (5 Minute Journal) — "Today" + date tile "WED 10" + daily affirmation, photo.
- https://mobbin.com/screens/34f76425-5418-4eb7-b21d-5036b84a9d63 (Abode) — "Memories": week strip, "Sam had a busy day! They worked on notes…" summary, activity log.

### Ask box on a home
- https://mobbin.com/screens/941076fc-9ed1-4ac0-9c6f-568e7104cd1d (Gemini) — "Ask away, Alex!" centered input, "Deep research" chip, model picker, mic, two wide buttons Sources / Files.
- https://mobbin.com/screens/a2fa46d5-4a02-46bc-b85d-341279ad422d (Reddit Answers) — input + "Recommended" 3×3 grid of question chips.
- https://mobbin.com/screens/a12fee97-a83c-465e-a6de-0d42cdd7ddec (Copilot) — "Hi Alex Smith, what should we dive into today?" + input with a "Quiz" mode chip + 8 suggestion pills.
- https://mobbin.com/screens/6c714027-d5db-4c9e-83ec-49424bd4c88f (Origin, finance) — a full dashboard with a small **"Ask anything"** pill bottom-left.

### Quick capture
- https://mobbin.com/screens/ff36cc00-fda2-4ea1-bdc0-029038bf3f0c (mymind) — "Search my mind…" top; bottom sticky **"ADD A NEW NOTE — Start typing here…"** inline input.
- https://mobbin.com/screens/6c71cfb0-d860-4dc7-9298-5223a2c0f574 (Wispr Flow) — "Scratchpad" grouped by "Today", card with title/text/time + "AI" chip; + FAB.
- https://mobbin.com/screens/d039487b-20fb-443b-ae17-4233daa31d44 (Granola) — "My notes": "Coming up (No upcoming meetings)", "Earlier today"; bottom "New note".

### Stat tiles / overview layouts (finance, fitness) as layout references
- https://mobbin.com/screens/a747c477-0008-44a0-b887-81dc4e75b44e (Rocket Money) — "Good evening, Sam"; big "Current spend this month $1,401" + line + orange chip "You've spent $361 more than last month"; right 1/3 "ACCOUNTS" list with "42 minutes ago · Sync now"; "RECENT TRANSACTIONS" table with "You've had 110 transactions so far this month".
- https://mobbin.com/screens/8c95bc4b-cdd9-42db-9322-eba9ff493d70 (Monarch) — "Welcome back, Sam!" + **Customize**; "Getting Started" progress bar checklist + "Hide this widget"; "Budget — You don't have a budget yet · Create my budget"; Spending "This month vs. last month"; Recurring empty state.
- https://mobbin.com/screens/c619f130-9193-472a-b1e2-1533aa227fd7 (Quicken) — "Hello, Sam! 👋", Customize; Accounts tree left 1/3; Net Worth big number + all-time change; "See all other Transactions"; Bills & Income cards with "today / in 5 days" chips.
- https://mobbin.com/screens/5b8d5290-6c52-436f-bac3-9d0a531db829 (Apple Fitness) — "Summary · Thursday, Sep 25"; Activity Ring card; 2-up "Step Count / Step Distance" cards with "Today" + hourly mini bars; "Trends" 2×2 with "–/–" placeholders; Workout.
- https://mobbin.com/screens/3328a9e4-f4a3-4f43-a0fc-7d029c884c85 (Oura) — five score circles (Readiness 83, Sleep 77, Resilience –, Activity 95); toast "Activity added · View details"; "Getting started" narrative.
- https://mobbin.com/screens/1c996718-ab94-4247-85b3-80885bab44c9 (Strava widgets) — streak week dots; weekly goal ring + day bars.

### Queues with counts
- https://mobbin.com/screens/18c6955a-c42f-4cc1-9aa2-0276456720fb (Linear) — sidebar "Inbox 7"; rows with unread dots + relative time; right pane empty state "7 unread notifications".
- https://mobbin.com/screens/566ff1fb-1737-472f-9f5c-2cef0105dfa2 (Brink) — chips "Queue · 1 | In Progress · 2 | Completed"; grouped Today / Yesterday; play "53 min" with progress.
- https://mobbin.com/screens/ff1bcb17-ca03-40b3-aee6-04b801e15019 (Matter) — "Queue" rows: favicon, title, "Source · 9h ago · 8 min", tag pills; tabs Discover / Inbox / Queue / Search.

## Patterns → myco

| # | Pattern | myco today | Proposal | Impact / Effort |
|---|---|---|---|---|
| 1 | Greeting + date line (Fabric, Plane, Rocket Money, Evernote iOS, Apple Fitness) | Static tagline `home_title` (`lib/everydayCopy.ts`), no date | Time-of-day greeting + `Intl.DateTimeFormat` weekday/date as the hero h2; tagline becomes the p | medium / S |
| 2 | Today's daily note is the first recent card (Craft) | `DailyNoteButton` only in `Sidebar.tsx:543` | First row of `RecentNotes` = today's note (open or create), "Updated x min ago" | high / S |
| 3 | Continue where you left off with progress + Resume (Uxcel, Coursera, Literal) | `navHistory` persisted (`uiStore.ts:86,326`), never shown; no scroll restore in `PageReader.tsx` | "Continue" card: last `page:` entry + nearest heading; save scrollTop per path on Reader unmount | high / M |
| 4 | Recents with "Last viewed by you today at 6:16 PM", folder pill, star (Coda, Zoom Docs, Elicit) | `RecentNotes.tsx:54-57` stem + relative day; mtime-only via `recentAuthored` | Split "Recently opened" (navHistory) from "Recently changed"; add folder pill + exact time for today + favorites star | medium / S |
| 5 | Queue counts as first-class numbers (Todoist Inbox/Today, Linear Inbox 7, Brink chips, Evernote Notes 42) | Badges only in sidebar (`Sidebar.tsx:297,318,374`); `_inbox/` count nowhere; home sums into "{n} items to review" | One "Today's queue" strip: harvest / inbox sources / proposals / due cards, each a link, zero hidden | high / S |
| 6 | Today's tasks with Overdue group + Reschedule + inline add (Todoist, Things) | Tasks only on PageTasks; `OverviewBoard.tsx:157` already fetches `scanTasks` for charts | "Today" block: overdue + due-today rows with checkbox and `+ Add task` | medium / M |
| 7 | Scratch pad / inline capture on the home (Evernote, Plane stickies, mymind, Wispr) | "Write" tile → `promptNewNote` → title prompt first (`lib/newNote.ts:49-51`); voice only in Spotlight | Inline capture textarea that appends to today's note on ⌘Enter; mic reuses Spotlight's `save_voice_capture` | high / M |
| 8 | Ask input on the home with suggestion chips (Notion iOS Ask AI, Gemini, Copilot, Reddit Answers, Origin) | Ask tile only navigates (`EverydayHome.tsx:50-63`); examples only in `PageQuery.tsx:415-430` | Replace the tile with a real input (`t.q_ph`) + 3 `copy.examples` chips; submit sets query text and routes | high / S |
| 9 | Yesterday/Today chronicle with linked entities (Dot), Memories summary (Abode) | `reunions` panel (`MorningBand.tsx:303-332`) hidden behind Manage; no on-this-day | Promote reunions to the simple home as "For today"; add on-this-day = `daily/` notes matching MM-DD of past years from `fileTree` | high / S+M |
| 10 | "Since you were here" headline as a comparison chip (Rocket Money, Quicken, Oura toast) | `since` panel computed (`MorningBand.tsx:191-197`) but behind Manage | One-line headline under the greeting linking to History | medium / S |
| 11 | Dismissible setup checklist (Fabric, Monarch, Evernote iOS) | Home has none (`PageOverview.tsx`) | 3-item checklist from existing stores (vault, provider, first ingest), localStorage dismiss | medium / S |
| 12 | Stat tiles first row, "Today" + mini bars (Apple Fitness, Oura, Quicken) | `VaultPulse` figures + 7-day strip behind Manage | Render `VaultPulse figures` compactly in the simple home; keep the canvas in Manage | medium / S |
| 13 | Single "Customize" entry + widget gallery with previews + size pictograms (Evernote flow, Monarch, Quicken, Notion Done) | Two systems (Arrange, Board); `<select>` presets; `window.prompt`/`confirm` (`OverviewBoard.tsx:393,416`); reachable only inside Manage | One Customize in `AppPage tools`; side-panel widget picker with mini previews; use `dialogStore.promptText` | medium / M |
| 14 | Widget empty state = icon + one line + one CTA (Monarch, Evernote, Notion, Linear) | `RecentNotes.tsx:33-35` muted text, no CTA | Empty recents shows Write / Add buttons | low / S |
| 15 | Section header chevrons / "See all" links (Fabric, Quicken, Coda tabs) | No see-all on Recent; Manage is one big fold | Header links: Recent → History, Queue → Ingest, Reunions → Study | low / S |
| 16 | 1280×800 fits: greeting line + 3-column card row above the fold (Evernote 1/3+2/3, Quicken 1/3+2/3, Rocket Money 2/3+1/3) | Hero (padding up to 2.75rem, h2 2.3rem, mascot 170px) + 2×6rem tiles + 4×3rem rows + 3.5rem Manage ≈ the whole viewport; content = 4 filenames | Greeting row (mascot 64px) → Ask + capture 2-col → Queue / For today / Recent 3-col | high / M |
| 17 | Week strip / streak dots under the header (Coursera, Strava, Things timed block) | `bucketByDay` computed in `PageOverview.tsx:78-81` but only used behind Manage | 7 dots under the greeting (filled = day with authored notes); click filters Recent | low / S |

Not on Mobbin: Obsidian, Readwise/Reader, Day One (Evernote, Matter/Brink, Dot/Abode used instead). Notion's web Home tab is not captured; its iOS Home and web database dashboards were used.
