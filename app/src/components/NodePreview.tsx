// In-place markdown preview for a vault page, shown under the mini galaxies
// (ingest progress, query answers). Keeps the user in context instead of
// navigating away; an explicit button opens the full reader.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import { ipc } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import Viewer from "./Viewer";

export default function NodePreview({
  t,
  absPath,
  label,
  refreshKey = 0,
  onOpen,
  onClose,
}: {
  t: Strings;
  absPath: string;
  label: string;
  /** Bump to re-fetch (e.g. ingest writeCount) so a page still being
   * written stays current. */
  refreshKey?: number;
  onOpen: () => void;
  onClose: () => void;
}): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ipc
      .readFile(absPath)
      .then((f) => {
        if (cancelled) return;
        setContent(f.content);
        setMissing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [absPath, refreshKey]);

  return (
    <div className="ingest-preview" role="region" aria-label={label}>
      <div className="ingest-preview-head">
        <span className="ingest-preview-path" title={label}>
          {label}
        </span>
        <button className="btn" onClick={onOpen}>
          {t.ing_preview_open}
        </button>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label={t.ing_preview_close}
          title={t.ing_preview_close}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="ingest-preview-body">
        {missing ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {t.ing_preview_writing}
          </div>
        ) : content === null ? (
          <div className="muted" style={{ fontSize: 12 }}>
            …
          </div>
        ) : (
          <Viewer content={content} />
        )}
      </div>
    </div>
  );
}
