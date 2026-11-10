# Mobbin research — key `polish-palette` (Linear, Raycast, Arc, Things 3, Superhuman)

Scope: command palette, shortcut discoverability, settings organisation, empty states, toasts, status indicators, icon+label consistency, dark/light parity. Compared against the installed tree `~/prj/karpathy-editor-build/app/src` (files cited per pattern).

## Coverage notes (what Mobbin does / does not have)

- **Linear (web)** and **Superhuman Mail (web)**: rich coverage; most evidence below.
- **Raycast**: not on Mobbin. Closest palettes used instead: Vapi, Mintlify, Juicebox, Navattic (all web).
- **Arc**: not on Mobbin as a desktop browser; only "Arc Search" (iOS) exists and its one hit is a tab switcher ([screen](https://mobbin.com/screens/f32ed434-4bc1-4cef-8b00-f2467b964865)) — unrelated to this key, not used.
- **Things 3**: iOS only; used for empty-state copy.
- Searched but no screen exists: Linear `?` shortcut cheat-sheet overlay; Linear sync/offline indicator; Linear tooltip-with-kbd (results were toasts/views). Superhuman's grouped shortcut panel stands in for the cheat sheet.

Searches run: 16 (Linear palette, Superhuman palette, Linear `?` sheet, Raycast palette, Linear settings, Linear empty states, Linear toasts, Linear inbox, Things 3 empty, Arc, Linear theme prefs, Linear new-issue modal, Superhuman undo toast, Superhuman onboarding flow, Linear tooltip, Linear sync status).

---

## Patterns

### 1. Per-row shortcut chip in the palette — Superhuman
**Seen:** dark palette; each row "Mark Done E · Remind Me H · Star S · Move V · Label L" with a keycap on the right edge. Onboarding copy: "access any feature in seconds — and learn its shortcut!"
[85dc5994](https://mobbin.com/screens/85dc5994-9360-428d-9092-7425e070ed7f) · [1f3fb485](https://mobbin.com/screens/1f3fb485-0f95-4826-bca2-74fed2449f6f)
**myco:** `components/CommandBar.tsx` rows end in a `cr-tag` type word (action / page / file / lens, L372–394). "New note" is bound to ⌘N in `App.tsx:472` and the palette never says so.
**Proposal:** optional `keys?: string` on `CmdEntry`; render `<span className="kbd">` in place of the type tag when present. Impact high · S.

### 2. Sectioned empty-query palette: Actions / Recent / All pages — Vapi (Raycast stand-in), Superhuman
**Seen:** Vapi: input "Search pages…", groups "Actions" (Switch Organization ⌘0), "Recent" (Metrics, Monitors, Integrations with a grey section suffix), "All Pages"; footer "↑↓ to navigate ↵ to select · 14 results". Superhuman's empty palette lists curated verbs (Search /, Filter Conversations, Use Snippet ⌘;) and a "Recent Opens" side panel.
[593d7acd](https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b) · [04a88f21](https://mobbin.com/screens/04a88f21-128b-416e-98c6-97e1db3b10af)
**myco:** `CommandBar.tsx:194` flattens `[...actions, ...navs, ...lenses, ...pages]` and slices 12 with no group labels (labels exist only for exact/content/semantic hits, L395–447). No recents, although `stores/uiStore.ts` keeps `navHistory.entries`.
**Proposal:** derive Recent from `navHistory` (`page:` routes, dedupe, last 5) and render group labels Actions / Recent / Go to / Lenses. Impact high · S.

### 3. Palette footer as a key legend + result count — Juicebox, Mintlify
**Seen:** Juicebox footer "↵ to select · ↑↓ to navigate · Tab to jump sections · ⌘K to toggle"; Mintlify "↑↓ Select · ↵ Open" and an ESC chip inside the input.
[84169c57](https://mobbin.com/screens/84169c57-5cd6-4495-bb71-93d37266f4c4) · [7c7ad31f](https://mobbin.com/screens/7c7ad31f-9dfe-4be7-83d7-6002fe31d4d0)
**myco:** `CommandBar.tsx:466–473` footer is a sentence ("Quotes for exact match · path: · tag: · Didn't find it? ⌥⏎ logs…"); no arrow/enter chips, no count. `esc` chip exists in the input (L363).
**Proposal:** chip row `↑↓ · ↵ open · ⌥↵ log miss · esc` left, `{total} results` right; move the operator hint into the placeholder. Impact medium · S.

### 4. Nested sub-palette with filter ("Move to…") — Superhuman, Linear
**Seen:** Superhuman "Move to …" replaces the palette title, lists News / Marketing / Spam ! / Trash # / Done E. Linear's Move-to submenu has a filter input and sections Projects / Initiatives.
[4dfa5b06](https://mobbin.com/screens/4dfa5b06-4d1e-4d17-bc3a-f7650b8f8612) · [f1e8745b](https://mobbin.com/screens/f1e8745b-81b7-4a78-85e1-a325f4843f42)
**myco:** `components/SidebarMenu.tsx:98–109` opens `pickDialog` whose `FolderList` (L204–227) is a column of buttons with no filter — painful on a 1121-file vault. The palette already has a nested mode (lens chip in input, Backspace drops it, L310–312).
**Proposal:** a `mode: "move"` in CommandBar that lists `folderChoices` filtered by the input; or, minimal, a filter input at the top of `FolderList`. Impact medium · M.

### 5. Context-menu rows carry icon + shortcut — Linear
**Seen:** document "…" menu: Move to ⇧P, Duplicate, Rename ⌥R, New template, Favorite ⌥F, Copy ⌘C, Remind me H, Version history, Delete — every row has a 16px icon and most a keycap.
[f1e8745b](https://mobbin.com/screens/f1e8745b-81b7-4a78-85e1-a325f4843f42)
**myco:** `SidebarMenu.tsx:152–198` rows are text-only buttons; `Sidebar.tsx:214–224` binds only Space and Shift+F10 on tree rows — no F2 / Delete / ⌘D.
**Proposal:** bind F2 rename, Backspace/Delete delete, ⌘D favorite on `TreeNode`; show those keys and an `Icon` per row in the menu. Impact medium · M.

### 6. Searchable, grouped shortcut panel — Superhuman
**Seen:** right-side "Search" panel with groups Actions / Navigation / Conversations, ~40 rows each with keycaps (⌘K, /, Z, J/K, enter, esc, shift+U…); typing "remove" filters to the Labels rows.
[3ae6bf95](https://mobbin.com/screens/3ae6bf95-6bbd-4232-b045-3160b748393c) · flow [fadbd9ca](https://mobbin.com/flows/fadbd9ca-cc57-4301-964d-29588a6ab149)
**myco:** `components/HelpWidget.tsx:63–81` is a static list of 10 (+2 on graph) with no search, no groups; no `?` key opens it (`App.tsx:461–490` binds only ⌘K ⌘B ⌘N ⌘[ ⌘]). Editor keys (⌘⌥ turn-into, `[[`, `/`) are absent.
**Proposal:** `lib/shortcuts.ts` registry `{scope, keys, labelKey}`; `?` (focus outside inputs/CodeMirror) opens a filterable panel; HelpWidget, palette chips and button chips all read the registry. Impact high · M.

### 7. Onboarding step that makes you press ⌘K — Linear, Fey, Superhuman
**Seen:** Linear "Meet the command menu — Try opening the command menu with: [⌘][K]" with progress dots; Fey "It's in your hands… press space to continue" over a palette with keycaps; Superhuman "Welcome to Superhuman Command… Type 'go to done'".
[1e783aca](https://mobbin.com/screens/1e783aca-8b8e-4ae5-994d-284a8ddae491) · [ff52ac90](https://mobbin.com/screens/ff52ac90-4d18-4765-98da-df1e362a5ee1) · [85dc5994](https://mobbin.com/screens/85dc5994-9360-428d-9092-7425e070ed7f)
**myco:** `components/OnboardingWizard.tsx` (steps folder → import → index → git → first ask; `lib/onboarding.ts WIZARD_STEPS = 5`) never mentions ⌘K or ⌥Space.
**Proposal:** one extra step after first-ask: "⌘K jumps anywhere · ⌥Space asks from any app", advancing when `uiStore.cmdOpen` flips true. Impact medium · S.

### 8. Primary CTA shows its shortcut chord — Linear
**Seen:** empty-state buttons "Create new initiative  N then I", "Create new project  N then P", "Add request  Ctrl R", milestone "Create new issue  C" — chip inside the filled button.
[5cc1bd35](https://mobbin.com/screens/5cc1bd35-b393-4c63-9b86-280b982247e0) · [136313ff](https://mobbin.com/screens/136313ff-44f9-4228-8d43-ac9beea6058f) · [60fb29a7](https://mobbin.com/screens/60fb29a7-f5c7-4df0-a7bc-6290d3f0ec93)
**myco:** `Sidebar.tsx:520–541` "+ New note" has no ⌘N; `Topbar.tsx:53,61,70` hide "(⌘B)", "(⌘[)" inside `title=`; `pages/PageTasks.tsx:470–478` empty card has no button at all. Only the search pill shows ⌘K (`Topbar.tsx:103`).
**Proposal:** `keys?` prop on `components/ui/Button` rendering the shared `.kbd`; use on New note (⌘N), Tasks "New task", Ingest drop CTA. Impact high · S.

### 9. Empty state = illustration + what-it-is + primary + docs link — Linear
**Seen:** Projects/Initiatives/Customers/Views/Inbox: centred line-art, bold title, 2–3 lines explaining the concept, filled primary, secondary "Documentation"; Views even prints its shortcut "⌥ V"; Inbox is just an icon + "No notifications".
[5273571d](https://mobbin.com/screens/5273571d-4f58-410a-97a0-f6018dc8b80f) · [9a431d93](https://mobbin.com/screens/9a431d93-86be-4e95-9af4-e30c5f01383a) · [5e4be052](https://mobbin.com/screens/5e4be052-1838-45d0-b850-fd7306cd4bff)
**myco:** three unrelated shapes — `PageQuery.tsx:409–433` (mascot + example buttons, good), `PageTasks.tsx:470–478` (card, no action), `RecentNotes.tsx:32–35` and `Sidebar.tsx:430–436` (one muted line, no action). `CommandBar.tsx:370` "No results" offers nothing.
**Proposal:** one `EmptyState` component (art, title, 1–2 lines, primary with kbd, optional secondary). Apply: Tasks (New task), Sidebar empty vault (New note ⌘N · Import), RecentNotes, palette no-results (Ask the wiki this → query prefill; visible "Log miss ⌥↵" button). Impact high · M.

### 10. Empty copy points at the control on screen — Things 3
**Seen:** "Tap or drag the plus button to create a new to-do." with the blue + FAB in view; Logbook coach-mark "All done — When you complete something, it moves to your Logbook…" anchored to the sidebar row.
[7e2dac24](https://mobbin.com/screens/7e2dac24-0465-4935-b8be-e1d80d3f0bf0) · [a54aa209](https://mobbin.com/screens/a54aa209-df0d-4994-96ca-88a7110a36b0)
**myco:** `Sidebar.tsx:430–436` "Empty vault" sits under the "+ New note" pill yet never names it; `CommandBar.tsx:370` "No results" never mentions ⌥↵.
**Proposal:** i18n copy edit: "Empty vault — press + New note above or ⌘N", "No results — ⌥↵ logs this search". Impact low · S.

### 11. Settings as one scrolling page of uniform rows — Linear
**Seen:** Preferences: section headers (General / Interface and theme / Desktop application / Coding tools / Automations and workflows); every row = title, one-line grey description, right-aligned control (dropdown / toggle / chevron); left nav grouped Issues / Projects / Features / Administration with "Back to app".
[d4e47b31](https://mobbin.com/screens/d4e47b31-9152-40c7-a400-c6725e8de647) · [abf277ec](https://mobbin.com/screens/abf277ec-d00a-4504-8cfa-54930315f0ab)
**myco:** `pages/PageSettings.tsx` = 8 tab panels (4 basic + 4 under "More settings"); each panel lays itself out (e.g. `pages/settings/Appearance.tsx:48–110` inline-styled 3-card grid). `components/SettingsCard.tsx` only wraps a card and pins the value chip — no shared row primitive, so description/control alignment differs per tab. Cross-tab search already works.
**Proposal:** `SettingsRow` (label, description, control slot) inside `SettingsCard`; render every panel as rows (theme previews become the control of one row). Keep tabs. Impact medium · M.

### 12. Theme choice reachable everywhere + tokenised colours — Linear
**Seen:** "Interface theme" dropdown: System preference / Light / Pure Light / Dark / Magic Blue / Classic Dark / Custom; onboarding "Choose your style — Change your theme at any time via the command menu or settings" with Light/Dark previews.
[59e38375](https://mobbin.com/screens/59e38375-a880-466b-8f29-b6e59358c61a) · [efc1c7a1](https://mobbin.com/screens/efc1c7a1-c215-4de7-be32-4f68a1bb3e20)
**myco:** `uiStore.Theme = light|dark|system` (parity OK), but not in the palette (`CommandBar.tsx` actions are New note / New from template only). Hardcoded colours bypass `[data-theme]`: `Topbar.tsx:411` RunPill dot `#16a34a`/`#dc2626`; `styles.css:5263, 5453, 5520, 7716, 7825` focus rings `#a78bfa`; ~19 differing `:focus-visible` rules.
**Proposal:** palette actions "Theme: Light / Dark / System"; `--ok`, `--danger`, `--focus` tokens in `:root` and `[data-theme="dark"]`; one `:focus-visible` rule on interactive elements. (Screenshot evidences the theme choice; token discipline is inferred.) Impact medium · S.

### 13. Customize sidebar (Always / When badged / Don't show) — Linear
**Seen:** modal "Customize sidebar": Default badge style (Dot ▾); Personal: Drafts "Show when badged", Inbox/My issues "Always show"; Workspace: Members/Teams "Don't show".
[9e6c1c6e](https://mobbin.com/screens/9e6c1c6e-764e-4314-8f7e-83106663422e)
**myco:** `Sidebar.tsx:38` hardcodes `TOOL_ROUTES` under a Tools disclosure; a user cannot promote Graph or hide Study.
**Proposal:** `uiStore.sidebarItems: Record<RouteId,"always"|"badged"|"hidden">`; small modal from a sidebar "…"; "badged" shows only while the badge > 0. Impact medium · M.

### 14. Toast = icon + title + sub + × close; destructive ops act-then-Undo — Linear, Superhuman
**Seen:** Linear bottom-right: "Notification deleted · Undo ×", "Subscribed to project / You will now receive updates…", "Copied message / Message copied to clipboard" — grey icon, bold title, one-line sub, × at right. Superhuman bottom-left: "Marked as Done. UNDO ×", "Draft discarded. UNDO ×", "Message sent. UNDO ×".
[14cbb61d](https://mobbin.com/screens/14cbb61d-2120-46fa-b29c-b7678e4b85cc) · [7833c5d5](https://mobbin.com/screens/7833c5d5-299e-415f-adf4-7f53e586e11a) · [b0cecd33](https://mobbin.com/screens/b0cecd33-9403-4c15-af1c-033d84826cf5) · [23660193](https://mobbin.com/screens/23660193-1d87-4462-9b18-a9f0dc06ccf5)
**myco:** `components/NoticeStack.tsx` has no close button — only Esc while focus is inside the stack (L36–42) or the TTL; `SidebarMenu.tsx:122–142` delete goes through a blocking `confirmAction` even though `vaultStore.ts:439` trashes (reversible).
**Proposal:** `×` IconButton on Toast; for single-item delete/move/favorite skip the confirm and push `{kind:"ok", title:"Moved to Trash", action:{label:"Undo", run: restore}}` (needs an untrash IPC). Impact high · M.

### 15. One-time coach mark teaching the key for what you just did by mouse — Superhuman
**Seen:** after sending: "Congratulations — Your message is sent! You can hit [Z] within 10 seconds to undo send. GOT IT"; after bulk move: "You can track progress or undo this action with ⌘Z → Bulk Actions" plus a small "We'll let you know when it's ready!" toast.
[b2f2daa3](https://mobbin.com/screens/b2f2daa3-df86-48ca-941f-6ec4b36aa581) · [22a53e52](https://mobbin.com/screens/22a53e52-5982-48e8-908d-01a41cd8bd2b)
**myco:** no contextual teaching: clicking sidebar New note never surfaces ⌘N; Spotlight prints "⏎ save · esc cancel" as plain text (`Spotlight.tsx:452`).
**Proposal:** `hintOnce(key)` in `noticeStore`: 3rd mouse activation of a shortcut-bound action pushes an info toast "Tip: ⌘N does this" once per key (localStorage). Impact medium · S.

### 16. Persistent inbox of finished background jobs — Langdock, Dovetail (Linear stand-ins)
**Seen:** Langdock "Inbox" modal: tabs Unread 1 / All / Usage requests, "Mark all as read", row "Deep research — Deep research has completed: … · 1 hour ago". Dovetail: "Your transcript … is ready! [View] 13h ago" with unread dots.
[dc3adbc9](https://mobbin.com/screens/dc3adbc9-3ae0-45fd-9f43-c8ab60a19052) · [3d315db6](https://mobbin.com/screens/3d315db6-ea16-4346-9cd2-4fd025da5f70)
**myco:** `Topbar.tsx` RunPills show one done/failed pill per source and clear on visiting the page (L395–397); toasts cap at 3 and expire (`noticeStore.ts:33`); `components/ActivityPanel.tsx` has no finished section (no "done/finished/history" in the file). An overnight distill + a failed ingest leave no readable trail.
**Proposal:** `noticeStore.log` (last 20 `{title, sub, kind, at, route}`) appended on every push and RunPill outcome; ActivityPanel "Recent" section; unread dot on the chip. Impact medium · M.

### 17. One keycap chip style everywhere — Linear, Superhuman
**Seen:** identical rounded keycaps in a filled button ("N then I"), a context menu ("⇧P"), and the shortcut panel.
[5cc1bd35](https://mobbin.com/screens/5cc1bd35-b393-4c63-9b86-280b982247e0) · [f1e8745b](https://mobbin.com/screens/f1e8745b-81b7-4a78-85e1-a325f4843f42) · [3ae6bf95](https://mobbin.com/screens/3ae6bf95-6bbd-4232-b045-3160b748393c)
**myco:** four renderings: `.kbd` (`styles.css:787` mono, bordered), `.qbtn .qkbd` (`:274` mono, no border), `.help-widget__sc-row kbd` (`:7166` inherit font, ink-2), plain text in Spotlight and `title=` attrs.
**Proposal:** `<Kbd>` in `components/ui` rendering `.kbd`; delete `.qkbd` and the help override; reuse `lib/shortcutAccel.formatAccel`. Impact medium · S.

### 18. Same 16px icon slot on every menu/palette row — Linear
**Seen:** "More" popover (Drafts, Initiatives, Members, Customers, Teams, Customize sidebar) and the document menu: every row has a monoline icon in the same left slot.
[37054da5](https://mobbin.com/screens/37054da5-16ca-474e-88a7-7d49e339d1bc) · [f1e8745b](https://mobbin.com/screens/f1e8745b-81b7-4a78-85e1-a325f4843f42)
**myco:** `CommandBar.tsx:480–494` rows have icons; `SidebarMenu.tsx` rows none; `StatusStrip.tsx:157–195` mixes PNG art (indexing/mcp/ask) with an inline SVG database glyph; `NoticeStack.tsx:111` uses 22px PNG `ActivityIcon` vs 13–16px line icons elsewhere.
**Proposal:** `Icon` per SidebarMenu item; line icons for status tiles; keep PNG activity art for the ActivityChip only. Impact low · S.

### 19. Dismissable example cards on the AI home — Linear
**Seen:** "Welcome to Linear / Ask anything…" with "Get started with some examples ×" and three cards (Create a new project / Research a topic / Draft a project update) each with a one-line sub.
[12fc9c16](https://mobbin.com/screens/12fc9c16-9010-423f-9ea7-0b5a1567880e)
**myco:** `PageQuery.tsx:415–432` always renders the same example buttons on an empty chat; no dismiss, no sub-line.
**Proposal:** × persisted in `uiStore`; examples rotate from the vault's most-linked pages with a one-line "why". Impact low · S.

---

## Suggested order (value ÷ effort)
1, 8, 17 (one `Kbd` + chips on palette rows and buttons — three small diffs that compound) → 2, 3 (palette groups/recents/footer) → 14 (× + Undo) → 9/10 (EmptyState) → 6 (`?` panel over a shortcut registry) → 12 tokens → 7, 15 → 11, 13, 16 → 4, 5, 18, 19.
