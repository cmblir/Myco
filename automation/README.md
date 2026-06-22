# Memex auto-ingest

Scheduled, unattended ingestion. Drop source files into your vault's `_inbox/`
folder and they are turned into wiki pages — with citations, following your
`CLAUDE.md` schema — automatically, on whatever schedule you set.

It uses **your own `claude` CLI** (your Pro/Max subscription, no API key, no
per-token billing), so it is free to run. The ingest agent gets the same hardened
tool set the app uses (`Read,Write,Edit,Glob,Grep` — never `Bash`), because
`_inbox/` content is untrusted.

## How it works

```
_inbox/article.md   ──pass──▶   raw/article.md   ──claude ingest──▶   wiki/* updated
                                (new file; raw/                         + citations,
                                 stays immutable)                       index.md, log.md
       │
       └─ on success ─▶ moved to _inbox/.archived/  (never deleted)
       └─ on failure ─▶ stays in _inbox/ to retry next pass; the raw/ file is rolled back
```

A JSONL record of every pass is written to `_inbox/autoingest.log.jsonl`.

## Run

```bash
# one pass now
python automation/autoingest.py --vault ~/Documents/Memex --once

# keep watching, every hour
python automation/autoingest.py --vault ~/Documents/Memex --interval 3600

# cheaper/faster or higher-quality model, and PDF/spreadsheet support
python automation/autoingest.py --vault ~/Documents/Memex --interval 3600 \
  --model haiku \
  --app-bin "/Applications/Memex.app/Contents/MacOS/Memex"   # enables --extract-text for PDF/XLSX
```

`--app-bin` points at the installed Memex binary so PDFs and spreadsheets are
extracted through the same isolated extractor the app uses. Without it, only
text-like sources (md/txt/csv/…) are ingested.

## Schedule it

### macOS — launchd (survives logout, runs in the background)

`~/Library/LaunchAgents/dev.cmblir.memex.autoingest.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.cmblir.memex.autoingest</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/path/to/Memex/automation/autoingest.py</string>
    <string>--vault</string><string>/Users/you/Documents/Memex</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>   <!-- every hour -->
  <key>StandardOutPath</key><string>/tmp/memex-autoingest.log</string>
  <key>StandardErrorPath</key><string>/tmp/memex-autoingest.err</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.cmblir.memex.autoingest.plist
```

### Linux / macOS — crontab

```cron
# every hour, on the hour
0 * * * * cd /path/to/Memex && /usr/bin/python3 automation/autoingest.py --vault ~/Documents/Memex --once >> /tmp/memex-autoingest.log 2>&1
```

Use `--once` for cron/launchd (the scheduler provides the interval). Use
`--interval N` only when running it yourself as a long-lived process.

> The `claude` CLI must be authenticated (`claude` works in your terminal) and on
> `PATH` for the scheduler's environment. cron has a minimal PATH — give the full
> path to `python3`, and if needed export `PATH` in the crontab.

## Terminal / MCP

When the Memex MCP server is registered with Claude (Desktop or Code), a
terminal-connected Claude can drive the same inbox: `list_inbox`,
`read_inbox_source`, and `archive_inbox_source` let it ingest pending sources
continuously using its own read/write tools. See the MCP server's tool list.
