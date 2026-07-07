# Topbar Model Picker + Responsive Topbar — Design

Date: 2026-07-07
Scope: `app/` (Tauri + React desktop app)

## Problem

1. **No inline model switching.** The topbar "claude ready" chip (`ModelChip` in
   `src/components/Topbar.tsx`) is read-only. Switching the query model requires
   opening Settings → Model. The chip also does a one-shot `ipc.getSettings()` in a
   mount-only `useEffect`, so it never reflects a model change made elsewhere until
   the app reloads.
2. **Topbar breaks on narrow desktop widths.** Responsive collapse rules exist only
   at `@media (max-width: 768px)` (phone → internal horizontal scroll). Between
   ~768px and ~1100px there is no rule: the flat flex row overflows and the
   right-most chip is clipped.

## Goals

- Switch the **query** provider+model directly from the topbar chip.
- Persist the choice and keep it two-way in sync with Settings → Model.
- Topbar degrades gracefully from full desktop width down to phone width with no
  clipping and no page-wide horizontal scroll.

## Non-goals

- Ingest model switching from the topbar (stays in Settings).
- Changing provider connection/keychain flows.
- Redesigning the Settings Model tab beyond the shared-component extraction.

## Key insight — sync is free

The topbar chip and the Settings Model tab will both read and write the **same**
zustand store field: `useSettingsStore().settings.query_provider` /
`query_model`. `settingsStore.update()` already writes back to disk
(`ipc.setSettings`) and every subscriber re-renders. So:

- Topbar → Settings sync: automatic (same store).
- Persistence across restarts: automatic (store mirrors `settings.json`).

No new IPC, no new persistence layer. The current chip's staleness is fixed purely
by subscribing to the store instead of calling `ipc.getSettings()` once.

## Architecture

### Shared extraction (`app/src/lib/providers.ts` — new)

Move provider catalog + connection logic out of `PageSettings.tsx` so both the
Settings tab and the topbar use one source:

- `ProviderDef` interface (currently `PageSettings.tsx:24`)
- `PROVIDERS: ProviderDef[]` (currently `PageSettings.tsx:34`)
- `PROVIDER_DESC_KEYS` + `providerDesc()` helper (currently `PageSettings.tsx:130`)
- `useEnabledProviders()` hook (currently `PageSettings.tsx:~320`)

`PageSettings.tsx` imports these from the new module (no behavior change there).

### Shared `<ModelSelect>` component

Extract the two-`<select>` body of Settings' `ModelPicker`
(`PageSettings.tsx:686`+ — provider select + model select + live-list fetch via
`ipc.listProviderModels`) into a reusable component:

```
ModelSelect({ providers, provider, model, onPick })
```

- Settings `ModelPicker` becomes the card/label wrapper around `<ModelSelect>`
  (keeps its `s_model_query` / `s_model_ingest` labels, `provider · model` caption).
- Topbar popover renders the same `<ModelSelect>` inside a floating panel.
- Single implementation of the model-list fetch + fallback-to-first-connected logic.

### Topbar chip → interactive picker (`Topbar.tsx`)

Rewrite `ModelChip`:

- Subscribe to `useSettingsStore` for `settings.query_provider` / `query_model`
  (reactive) instead of one-shot `ipc.getSettings()`.
- Keep the readiness probe (`ipc.claudeCheck()` / `ipc.ollamaStatus()` /
  builtin-always-ready / API-enabled-flag) in a `useEffect` keyed on
  `query_provider` so the dot re-evaluates when the provider changes.
- Render as a `<button className="pill">`: green/grey `.dot` + provider label +
  a small caret icon.
- Click toggles a popover panel anchored beneath the chip containing
  `<ModelSelect providers={useEnabledProviders()} provider={query_provider}
  model={query_model} onPick={(p, m) => update({ query_provider: p, query_model: m })} />`.
- Popover closes on outside-click and Escape (a small `useEffect` with a
  `mousedown` + `keydown` listener on `document`, cleaned up on unmount).

## Responsive topbar (`styles.css`)

Add progressive collapse between the wide default and the existing `≤768px` phone
rule. New media queries:

- **`@media (max-width: 1024px)`** — search pill hides its text label; shows the
  search icon + `⌘K` kbd only. (Add a wrapper class on the label span, e.g.
  `.pill-label`, hidden at this width.)
- **`@media (max-width: 900px)`** — `.breadcrumb` gets `min-width: 0; overflow:
  hidden`; the last crumb `b` gets `text-overflow: ellipsis; white-space: nowrap;
  overflow: hidden`. Chips keep dot + short label.
- **`@media (max-width: 768px)`** — unchanged (off-canvas sidebar + internal
  scroll already handled at `styles.css:2532`).

The topbar-spacer (`flex: 1`) continues to push chips right. Search pill made
shrinkable (`min-width: 0`) so the row fits down to ~600px before the phone rule's
internal-scroll fallback engages.

## i18n

- Reuse `t.s_model_query` for the popover.
- Add `aria-label` string(s) for the picker button/panel in all three locales
  (`en`, `ko`, `ja`) in `src/lib/i18n.ts` — e.g. `tb_model_picker` = "Switch query
  model".

## Error handling

- Chip: if the store's `settings` is `null` (not loaded yet), render nothing (as
  today). If the readiness probe throws, show the grey/offline dot — never crash.
- `update()` already rolls back the optimistic write and sets `error` on a failed
  disk write; the picker inherits that. No new error path.

## Testing / verification

Manual (per global UI checklist), since this is UI wiring on an existing store:

1. Topbar picker changes query model → reload app → selection persisted.
2. Change model in Settings → Model → topbar chip label/dot updates live (no reload).
3. Change model in topbar → open Settings → Model → picker reflects it.
4. Readiness dot: switch to a disconnected/offline provider → dot goes grey.
5. Resize window at 1280 / 1024 / 900 / 768 / 375px → no clipping, no page-wide
   horizontal scroll, popover opens and is fully visible at each width.
6. Keyboard: chip focusable, popover closes on Esc, outside-click closes it.

If the app has component tests for `PageSettings`/`Topbar`, add a test that picking
in the topbar calls `settingsStore.update` with the expected patch, and that the
chip renders the store's provider label. (Confirm test setup during planning.)
