// "Recently moved notes" — the mtime-based replacement for the dashboard's git
// log. The real vault is not a git repository, so the git list rendered empty
// forever; mtime works in every vault.

import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { recentAuthored } from "../lib/vaultPulse";

export default function RecentNotes({
  t,
  entries,
  vaultRoot,
  limit = 6,
}: {
  t: Strings;
  entries: [string, number][];
  vaultRoot: string;
  limit?: number;
}): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const rows = recentAuthored(entries, vaultRoot, limit);

  return (
    <section>
      <div className="section-head">
        <div className="section-title">{t.ov_recent_moved ?? "Recently moved"}</div>
      </div>
      {rows.length === 0 ? (
        <p className="muted" style={{ padding: "10px 6px", fontSize: 12.5 }}>
          {t.ov_recent_never ?? "No notes have changed yet."}
        </p>
      ) : (
        <div className="list">
          {rows.map((r) => (
            <button
              key={r.rel}
              type="button"
              className="list-row recent-row"
              // The route reads an ABSOLUTE path (it hands it to ipc.readFile),
              // so rejoin the root — a relative path dies on "canonicalize
              // failed for wiki/…", which this codebase has hit before.
              onClick={() => setRoute(`page:${vaultRoot}/${r.rel}` as RouteId)}
            >
              <span className="ic">
                <Icon name="page" size={14} />
              </span>
              <span style={{ fontWeight: 500 }}>
                {r.rel.split("/").pop()?.replace(/\.md$/i, "")}
              </span>
              <span className="meta">{relativeDay(r.mtime)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** "2 days ago" style label. Intl.RelativeTimeFormat handles the wording and
 *  pluralisation per language, so nothing here needs translating. */
function relativeDay(mtime: number, now: Date = new Date()): string {
  const then = new Date(mtime * 1000);
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((a.getTime() - b.getTime()) / 86_400_000);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(days, "day");
}
