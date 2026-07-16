# Memex Web Clipper

Sends the current page (URL, title, and any selected text) into your Memex
vault's `_inbox/` as a markdown source doc — the ingest pipeline turns it into
a cited wiki page from there.

It works through a `memx://clip?...` deep link handled by the Memex desktop
app. Nothing leaves your machine: no network requests, no storage, no
analytics.

## Requirements

- Memex desktop app **installed from a built bundle** (`npm run tauri build`).
  Custom URL schemes are registered by the OS at install time — the `memx:`
  scheme is **not** active under `npm run tauri dev` on macOS.
- A vault opened at least once (clips land in the last active vault).

## Option A — browser extension (Chrome / Edge / Brave)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `clipper/` folder.
3. Clip via the toolbar button or the right-click → **Clip to Memex** menu
   (selected text comes along).

The first clip asks the browser for permission to open the external `memx:`
handler — allow it (optionally "always").

## Option B — bookmarklet (any browser)

Create a bookmark with this URL:

```
javascript:(()=>{const s=String(getSelection()||'').slice(0,20000);const p=new URLSearchParams();if(/^https?:/.test(location.href))p.set('url',location.href);p.set('title',document.title.slice(0,300));if(s)p.set('selection',s);location.href='memx://clip?'+p.toString();})()
```

## Security notes

The app treats every incoming clip as hostile input: only `http(s)` source
URLs are accepted, titles/selections are length-capped and stripped of control
characters, and the saved filename is derived from a whitelisted slug — a clip
can only ever create a new file inside `<vault>/_inbox/`.
