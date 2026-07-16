// Zotero import card (Ingest page) — pick a Zotero export (CSL-JSON or
// BibTeX; annotations included when present) and drop every item into the
// vault's `_inbox/` as a markdown source doc. From there the normal ingest
// pipeline (manual run or scheduled auto-ingest) turns them into cited wiki
// pages — this card only translates formats, it never calls a model.

import { useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { inboxFilename, parseZoteroExport, toSourceMarkdown } from "../lib/zoteroImport";

export default function ZoteroImport({ t }: { t: Strings }): JSX.Element | null {
  const currentVault = useVaultStore((s) => s.currentVault);
  const refreshTree = useVaultStore((s) => s.refreshTree);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!currentVault) return null;

  async function importFile(f: File): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const items = parseZoteroExport(await f.text());
      if (items.length === 0) {
        setResult(t.zi_none ?? "No importable items found in that file.");
        return;
      }
      const root = currentVault!.path;
      // `_inbox/` must exist before write_file (it does not create parents);
      // create_folder is a no-op error if it already does — ignore that.
      await ipc.createFolder(root, "_inbox").catch(() => undefined);
      let written = 0;
      for (const item of items) {
        const path = `${root}/_inbox/${inboxFilename(item)}`;
        await ipc.writeFile(path, toSourceMarkdown(item));
        written++;
      }
      await refreshTree();
      setResult(
        (t.zi_done ?? "Imported {n} item(s) into _inbox/ — run Ingest to turn them into wiki pages.").replace(
          "{n}",
          String(written),
        ),
      );
    } catch (e) {
      setResult(String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="card zotero-import">
      <div className="section-title" style={{ fontSize: 14 }}>
        <Icon name="book" size={14} /> {t.zi_title ?? "Import from Zotero"}
      </div>
      <p className="muted zotero-import__hint">
        {t.zi_hint ??
          "CSL-JSON or BibTeX export (highlights come along when present). Items land in _inbox/ as source docs for the ingest pipeline."}
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.bib,.bibtex,application/json"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
        }}
      />
      {result ? <p className="zotero-import__result">{result}</p> : null}
    </section>
  );
}
