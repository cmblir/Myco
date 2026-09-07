// Connections — backlinks, semantic neighbours and this page's link
// suggestions as ONE rail block (mockup "Manuscript"). It replaces
// BacklinksPanel + RelatedPanel below the body plus the Overview-only
// suggestion queue for this page: three titles, three empty states and three
// scroll positions became one. Accepting writes through the shared
// `acceptSuggestion` — no second way to land a wikilink.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc, type VecHit } from "../lib/ipc";
import { notice } from "../lib/notice";
import Rail from "./Rail";
import { connectionRows, type ConnRow } from "../lib/readerRail";
import {
  acceptSuggestion,
  suggestLinks,
  type LinkSuggestion,
  type LinkSuggestionIO,
} from "../lib/linkSuggestions";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useReindexStore } from "../stores/reindexStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

/** Matches `ls-leave` in styles.css: an accepted row slides out before it goes. */
const LEAVE_MS = 320;

export default function ConnectionsPanel({
  filePath,
  io,
  t,
}: {
  filePath: string;
  /** Where an accepted wikilink is written. The reader passes an IO backed by
   *  the OPEN draft, so the append lands in the editor instead of racing the
   *  autosave that would overwrite it. */
  io: LinkSuggestionIO;
  t: Strings;
}): JSX.Element {
  const adjacency = useVaultStore((s) => s.adjacency);
  const refreshLinkGraph = useVaultStore((s) => s.refreshLinkGraph);
  const vaultRoot = useVaultStore((s) => s.currentVault?.path ?? "");
  const setRoute = useUIStore((s) => s.setRoute);
  const sem = useLinkSuggestStore((s) => s.sem);
  const dismissed = useLinkSuggestStore((s) => s.dismissed);
  const refreshSem = useLinkSuggestStore((s) => s.refresh);
  const dismissKeys = useLinkSuggestStore((s) => s.dismiss);
  const indexedPages = useReindexStore((s) => s.indexedPages);
  const refreshStatus = useReindexStore((s) => s.refreshStatus);
  const [related, setRelated] = useState<VecHit[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [leavingKey, setLeavingKey] = useState<string | null>(null);

  useEffect(() => {
    if (indexedPages === null) void refreshStatus();
  }, [indexedPages, refreshStatus]);

  // Same retry signal the Overview card uses: the store dedupes by adjacency
  // reference, so both mounted at once still fetch once.
  useEffect(() => {
    void refreshSem(adjacency);
  }, [adjacency, refreshSem]);

  // The index keys pages vault-relative ("wiki/foo.md").
  const rel =
    vaultRoot && filePath.startsWith(vaultRoot)
      ? filePath.slice(vaultRoot.length).replace(/^[\\/]/, "").replace(/\\/g, "/")
      : filePath.replace(/\\/g, "/");

  useEffect(() => {
    let alive = true;
    setRelated(null);
    ipc
      .relatedPages(rel, 8)
      .then((r) => {
        if (alive) setRelated(r);
      })
      .catch(() => {
        if (alive) setRelated([]);
      });
    return () => {
      alive = false;
    };
  }, [rel]);

  const suggestions =
    adjacency && sem
      ? suggestLinks(adjacency, sem, dismissed, Number.POSITIVE_INFINITY).filter(
          (s) => s.source === filePath || s.target === filePath,
        )
      : [];
  const rows = connectionRows({
    filePath,
    backward: adjacency?.backward[filePath],
    related,
    vaultRoot,
    suggestions,
  });

  async function accept(s: LinkSuggestion): Promise<void> {
    setBusyKey(s.key);
    try {
      await acceptSuggestion(s, io);
      setLeavingKey(s.key);
      await new Promise((r) => setTimeout(r, LEAVE_MS));
      dismissKeys([s.key]); // accepted pairs also leave the queue
      await refreshLinkGraph();
      notice.ok(
        (t.rd_conn_added ?? "[[{name}]] added under ## Related").replace(
          "{name}",
          nameOf(s.target),
        ),
        { icon: "link" },
      );
    } catch (e) {
      notice.warn(t.ls_toast_failed ?? "Couldn't add the links", {
        sub: String(e),
        action: { label: t.ls_toast_retry ?? "Retry", run: () => void accept(s) },
      });
    } finally {
      setBusyKey(null);
      setLeavingKey(null);
    }
  }

  return (
    <Rail
      title={t.rd_conn_title ?? "Connections"}
      count={rows.length > 0 ? rows.length : undefined}
    >
      {rows.length === 0 ? (
        <>
          <p className="rail-empty">{t.rd_conn_empty ?? "Nothing links here yet."}</p>
          {indexedPages === 0 ? (
            <button type="button" className="btn" onClick={() => setRoute("settings")}>
              {t.rd_related_no_index_cta ?? "Set up semantic search"}
            </button>
          ) : null}
        </>
      ) : (
        <ul className="rail-list conn">
          {rows.map((row) => (
            <li
              key={row.path}
              className={leavingKey === row.suggestion?.key ? "is-leaving" : undefined}
            >
              <span className={`rail-tag t-${row.kind}`}>{label(row, t)}</span>
              <button
                type="button"
                className="rail-conn__name"
                title={row.path}
                onClick={() => setRoute(`page:${row.path}`)}
              >
                {row.name}
              </button>
              {row.score !== undefined ? (
                <span className="rail-n">{(row.score * 100).toFixed(0)}%</span>
              ) : null}
              {row.suggestion ? (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={busyKey !== null}
                    aria-label={t.ls_accept ?? "Link them"}
                    title={t.ls_accept ?? "Link them"}
                    onClick={() => void accept(row.suggestion as LinkSuggestion)}
                  >
                    <Icon name="check" size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={busyKey !== null}
                    aria-label={t.ls_dismiss ?? "Dismiss"}
                    title={t.ls_dismiss ?? "Dismiss"}
                    onClick={() => dismissKeys([row.suggestion?.key ?? ""])}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Rail>
  );
}

function label(row: ConnRow, t: Strings): string {
  if (row.kind === "backlink") return t.rd_conn_back ?? "Backlink";
  if (row.kind === "related") return t.rd_related ?? "Related";
  return t.rd_conn_sug ?? "Suggested";
}

function nameOf(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");
}
