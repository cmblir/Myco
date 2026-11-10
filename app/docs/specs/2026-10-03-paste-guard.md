# Paste guard: every path into raw/ runs the same secret/PII check

The web-link import (S38) scans fetched text before it can reach raw/. Pasted text and YouTube
transcripts still go to raw/ unscanned, and raw/ is immutable. One secret pasted by mistake stays
forever.

1. **The same check everywhere.** Pasted text and fetched YouTube transcripts run the check the link
   import uses: `ipc.scanTextSecrets` followed by `redaction.shouldPromote`. They run it before
   ingest writes `raw/`.
   - **Secret:** refused, with a plain message (en/ko/ja) naming what was found but never echoing
     it. The text stays in the box so the owner can edit it.
   - **PII:** refused when the vault's PII setting is quarantine, otherwise a warning line.
   - **Scan failure:** refused (fail closed).
2. **One helper.** The link import's check (`webLink.ts`) moves into one shared helper used by all
   three paths. There are no copies.
3. **README.** The en and ko READMEs gain the web-link import (S38): what it fetches, what it
   refuses, and that nothing is saved before Run. They also gain the paste/transcript check.
