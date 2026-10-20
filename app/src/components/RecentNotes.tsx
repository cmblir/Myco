// "Recently moved notes" — the mtime-based replacement for the dashboard's git
// log. The real vault is not a git repository, so the git list rendered empty
// forever; mtime works in every vault.

import type { JSX } from "react";
import { listedName } from "../lib/displayName";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { Adjacency, NodeMeta } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { recentAuthored } from "../lib/vaultPulse";
import { openDailyNote } from "../lib/dailyNote";
import { today } from "../lib/taskLine";
import DayConnections from "./DayConnections";

export default function RecentNotes({
  t,
  entries,
  vaultRoot,
  meta,
  adjacency,
  limit = 6,
}: {
  t: Strings;
  entries: [string, number][];
  vaultRoot: string;
  /** adjacency.meta: a Tidy title names an opaque session page. */
  meta?: Record<string, NodeMeta>;
  /** The link graph: with it, today's new connections show under the list. */
  adjacency?: Adjacency | null;
  limit?: number;
}): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const lang = useUIStore((s) => s.lang);
  const day = today();
  const todayPath = `${vaultRoot}/daily/${day}.md`;
  // Today's note leads the list (UX S7), so it is not repeated below it.
  const rows = recentAuthored(
    entries.filter(([p]) => p !== todayPath),
    vaultRoot,
    limit,
  );

  return (
    <section>
      <div className="section-head">
        <div className="section-title">{t.ov_recent_moved ?? "Recently moved"}</div>
      </div>
      <div className="list">
        {/* Opens today's note, creating it on first use. */}
        {vaultRoot ? (
          <button
            type="button"
            className="list-row recent-row"
            onClick={() => void openDailyNote(vaultRoot, day)}
          >
            <span className="ic">
              <Icon name="calendar" size={14} />
            </span>
            <span className="recent-row__name">{t.sb_today_note}</span>
          </button>
        ) : null}
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
            {/* Ellipsized, not wrapped: in a half-width column a long stem
                ("analysis-rlhf-vs-dpo") broke the row to two lines and
                pushed its date out of alignment with every other row. */}
            <span className="recent-row__name" title={stemOf(r.rel)}>
              {listedName(stemOf(r.rel), meta?.[`${vaultRoot}/${r.rel}`]?.title)}
            </span>
            <span className="meta">{relativeDay(r.mtime, lang)}</span>
          </button>
        ))}
      </div>
      {/* The Today's note row already stands for a change to today's note. */}
      {rows.length === 0 && !entries.some(([p]) => p === todayPath) ? (
        <p className="muted" style={{ padding: "10px 6px", fontSize: 12.5 }}>
          {t.ov_recent_never ?? "No notes have changed yet."}
        </p>
      ) : null}
      {adjacency && vaultRoot ? (
        <DayConnections
          t={t}
          vaultRoot={vaultRoot}
          adjacency={adjacency}
          entries={entries}
          nameOf={(rel) => listedName(stemOf(rel), meta?.[`${vaultRoot}/${rel}`]?.title)}
          open={(rel) => setRoute(`page:${vaultRoot}/${rel}` as RouteId)}
        />
      ) : null}
    </section>
  );
}

/** File stem of a vault-relative path: the row's identity, kept in its
 *  tooltip when listedName renames it. */
function stemOf(rel: string): string {
  return rel.split("/").pop()?.replace(/\.md$/i, "") ?? rel;
}

/** "2 days ago" style label. Intl.RelativeTimeFormat handles the wording and
 *  pluralisation per language, so nothing here needs translating. */
function relativeDay(mtime: number, lang: string, now: Date = new Date()): string {
  const then = new Date(mtime * 1000);
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((a.getTime() - b.getTime()) / 86_400_000);
  return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(
    days,
    "day",
  );
}
