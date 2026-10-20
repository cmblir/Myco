// Connections — backlinks, semantic neighbours and this page's link
// suggestions as ONE rail block (mockup "Manuscript"). It replaces
// BacklinksPanel + RelatedPanel below the body plus the Overview-only
// suggestion queue for this page: three titles, three empty states and three
// scroll positions became one. Accepting writes through the shared
// `acceptSuggestion` — no second way to land a wikilink.

import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import { listedName } from "../lib/displayName";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc, type VecHit } from "../lib/ipc";
import Rail from "./Rail";
import { stem } from "../lib/graphData";
import {
  connectionRows,
  linkContext,
  type ConnRow,
  type LinkContext,
} from "../lib/readerRail";
import {
  suggestLinks,
  type LinkSuggestion,
  type LinkSuggestionIO,
} from "../lib/linkSuggestions";
import { applyLinkSuggestions, registerLinkDraft } from "../lib/linkActions";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useNoteInsertStore } from "../stores/noteInsertStore";
import { useReindexStore } from "../stores/reindexStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

/** Matches `ls-leave` in styles.css: an accepted row slides out before it goes. */
const LEAVE_MS = 320;

/** Backlinks whose note is read for its linking sentence. ponytail: a hub
 *  note past this many lists the rest by name only; read on scroll if one
 *  ever needs them all. */
const CONTEXT_READS = 50;

const KINDS = ["backlink", "related", "suggested"] as const;

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
  const revision = useVaultStore((s) => s.revision);
  const vaultRoot = useVaultStore((s) => s.currentVault?.path ?? "");
  const setRoute = useUIStore((s) => s.setRoute);
  const sem = useLinkSuggestStore((s) => s.sem);
  const dismissed = useLinkSuggestStore((s) => s.dismissed);
  const refreshSem = useLinkSuggestStore((s) => s.refresh);
  const linkBusy = useLinkSuggestStore((s) => s.busy);
  const dismissKeys = useLinkSuggestStore((s) => s.dismiss);
  const indexedPages = useReindexStore((s) => s.indexedPages);
  const refreshStatus = useReindexStore((s) => s.refreshStatus);
  const insert = useNoteInsertStore((s) => s.insert);
  const [related, setRelated] = useState<VecHit[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [leavingKey, setLeavingKey] = useState<string | null>(null);
  // Tagged with the note they were read for, so a note opened next never
  // shows the previous note's sentences while its own load.
  const [contexts, setContexts] = useState<{
    for: string;
    map: ReadonlyMap<string, LinkContext>;
  } | null>(null);
  const subId = useId();

  useEffect(() => registerLinkDraft(filePath, io), [filePath, io]);

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

  const backward = adjacency?.backward[filePath];
  // The list as a string: a graph rebuild hands over a new array every time,
  // and only a changed list is worth re-reading the notes for — or a moved
  // vault fingerprint, since a prose edit elsewhere keeps the list the same.
  const backKey = backward?.join("\n") ?? "";
  useEffect(() => {
    let alive = true;
    const target = stem(filePath);
    const paths = backKey ? backKey.split("\n").slice(0, CONTEXT_READS) : [];
    void Promise.all(
      paths.map((p) =>
        ipc.readFile(p).then(
          (f) => [p, linkContext(f.raw, target)] as const,
          // An unreadable note keeps its row, named, without a sentence.
          () => [p, null] as const,
        ),
      ),
    ).then((pairs) => {
      if (!alive) return;
      const map = new Map<string, LinkContext>();
      for (const [p, c] of pairs) if (c) map.set(p, c);
      setContexts({ for: filePath, map });
    });
    return () => {
      alive = false;
    };
  }, [filePath, backKey, revision]);

  const suggestions =
    adjacency && sem
      ? suggestLinks(adjacency, sem, dismissed, Number.POSITIVE_INFINITY).filter(
          (s) => s.source === filePath || s.target === filePath,
        )
      : [];
  const rows = connectionRows({
    filePath,
    backward,
    related,
    vaultRoot,
    suggestions,
    contexts: contexts?.for === filePath ? contexts.map : undefined,
  });
  // One sub-list per relationship, in the rows' own order; empty ones hidden.
  const groups = KINDS.map((kind) => ({
    kind,
    rows: rows.filter((r) => r.kind === kind),
  })).filter((g) => g.rows.length > 0);

  async function accept(s: LinkSuggestion): Promise<void> {
    setBusyKey(s.key);
    try {
      await applyLinkSuggestions([s], {
        io,
        onAccepted: async () => {
          setLeavingKey(s.key);
          await new Promise((r) => setTimeout(r, LEAVE_MS));
        },
        successTitle: t.rd_conn_added.replace("{name}", nameOf(s.target)),
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
        groups.map((g) => (
          <div key={g.kind} className="rail-conn__group">
            <div className="rail-conn__sub" id={`${subId}-${g.kind}`}>
              {groupLabel(g.kind, t)}
              <span className="rail-n">{g.rows.length}</span>
            </div>
            <ul className="rail-list conn" aria-labelledby={`${subId}-${g.kind}`}>
              {g.rows.map((row) => (
                <li
                  key={row.path}
                  // Only a suggestion is ever leaving; only a backlink has a sentence.
                  className={
                    row.context
                      ? "has-ctx"
                      : leavingKey === row.suggestion?.key
                        ? "is-leaving"
                        : undefined
                  }
                >
                  <span className={`rail-tag t-${row.kind}`}>{label(row, t)}</span>
                  <button
                    type="button"
                    className="rail-conn__name"
                    title={row.path}
                    onClick={() => setRoute(`page:${row.path}`)}
                  >
                    {listedName(row.name, adjacency?.meta?.[row.path]?.title)}
                  </button>
                  {row.score !== undefined ? (
                    <span className="rail-n">{(row.score * 100).toFixed(0)}%</span>
                  ) : null}
                  {insert ? (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={t.ins_link}
                      title={t.ins_link}
                      onClick={() => insert(`[[${row.name}]]`, false)}
                    >
                      <Icon name="link" size={13} />
                    </button>
                  ) : null}
                  {row.suggestion ? (
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={busyKey !== null || linkBusy}
                        aria-label={t.ls_accept ?? "Link them"}
                        title={t.ls_accept ?? "Link them"}
                        onClick={() => void accept(row.suggestion as LinkSuggestion)}
                      >
                        <Icon name="check" size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={busyKey !== null || linkBusy}
                        aria-label={t.ls_dismiss ?? "Dismiss"}
                        title={t.ls_dismiss ?? "Dismiss"}
                        onClick={() => dismissKeys([row.suggestion?.key ?? ""])}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </>
                  ) : null}
                  {row.context ? (
                    <p className="rail-conn__ctx">
                      {row.context.before}
                      <mark>{row.context.link}</mark>
                      {row.context.after}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </Rail>
  );
}

function label(row: ConnRow, t: Strings): string {
  if (row.kind === "backlink") return t.rd_conn_back ?? "Backlink";
  if (row.kind === "related") return t.rd_related ?? "Related";
  return t.rd_conn_sug ?? "Suggested";
}

function groupLabel(kind: ConnRow["kind"], t: Strings): string {
  if (kind === "backlink") return t.rd_conn_backs ?? "Backlinks";
  if (kind === "related") return t.rd_related ?? "Related";
  return t.rd_conn_sug ?? "Suggested";
}

function nameOf(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");
}
