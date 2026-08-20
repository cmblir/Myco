# myco Web Clipper

Sends the current page (URL, title, and any selected text) into your myco
vault's `_inbox/` as a markdown source doc — the ingest pipeline turns it into
a cited wiki page from there.

The doc carries its provenance in frontmatter, so a clipped claim can be traced
back to the page it came from:

```yaml
---
source: clipper
url: "https://example.com/article"
title: "The article's title"
created: 1755000000
clipped: 1755000000
---
```

`source`/`title`/`created` are the same fields the conversation importers write,
so the citation and distill passes read a clip with no special case. A page you
have already clipped is recognised (by URL, through the vault's import ledger)
and reported as "Already clipped" instead of being written a second time.

It works through a `myco://clip?...` deep link handled by the myco desktop
app. The pre-rename `memx://` scheme is still registered and still accepted,
so a bookmarklet or an unpacked extension you saved earlier keeps working. Nothing leaves your machine: no network requests, no storage, no
analytics.

## Requirements

- myco desktop app **installed from a built bundle** (`npm run tauri build`).
  Custom URL schemes are registered by the OS at install time — the `myco:`
  scheme is **not** active under `npm run tauri dev` on macOS.
- A vault opened at least once (clips land in the last active vault).

## Option A — browser extension (Chrome / Edge / Brave)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `clipper/` folder.
3. Clip via the toolbar button or the right-click → **Clip to myco** menu
   (selected text comes along).

The first clip asks the browser for permission to open the external `myco:`
handler — allow it (optionally "always").

## Option B — bookmarklet (any browser)

Create a bookmark with this URL:

```
javascript:(()=>{const s=String(getSelection()||'').slice(0,20000);const p=new URLSearchParams();if(/^https?:/.test(location.href))p.set('url',location.href);p.set('title',document.title.slice(0,300));if(s)p.set('selection',s);location.href='myco://clip?'+p.toString();})()
```

## Security notes

The app treats every incoming clip as hostile input: only `http(s)` source
URLs are accepted, titles/selections are length-capped and stripped of control
characters, and the saved filename is derived from a whitelisted slug — a clip
can only ever create a new file inside `<vault>/_inbox/`.
