// "Today's connections" under Home's recent list (UX S40): the note pairs that
// got linked today and the citations added, counted from the link graph. No
// model and no summary, so the line never says more than the vault does.

import { useEffect, useMemo } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import type { Adjacency } from "../lib/ipc";
import {
  loadDayLinks,
  newToday,
  rollDay,
  saveDayLinks,
  snapshot,
} from "../lib/dayConnections";
import { today } from "../lib/taskLine";

export default function DayConnections({
  t,
  vaultRoot,
  adjacency,
  entries,
  nameOf,
  open,
}: {
  t: Strings;
  vaultRoot: string;
  adjacency: Adjacency;
  entries: [string, number][];
  nameOf: (rel: string) => string;
  open: (rel: string) => void;
}): JSX.Element {
  const day = today();
  const state = useMemo(
    () => rollDay(loadDayLinks(vaultRoot), snapshot(adjacency, vaultRoot), day),
    [vaultRoot, adjacency, day],
  );
  useEffect(() => saveDayLinks(vaultRoot, state), [vaultRoot, state]);

  const found = useMemo(() => {
    const prefix = `${vaultRoot}/`;
    const saved = new Set(
      entries
        .filter(([p, mtime]) => p.startsWith(prefix) && today(new Date(mtime * 1000)) === day)
        .map(([p]) => p.slice(prefix.length)),
    );
    return newToday(state.base, adjacency, vaultRoot, saved);
  }, [entries, vaultRoot, day, state.base, adjacency]);

  return <DayConnectionsLine t={t} {...found} nameOf={nameOf} open={open} />;
}

export function DayConnectionsLine({
  t,
  pairs,
  cites,
  nameOf,
  open,
}: {
  t: Strings;
  pairs: [string, string][];
  cites: number;
  nameOf: (rel: string) => string;
  open: (rel: string) => void;
}): JSX.Element {
  const note = (rel: string): JSX.Element => (
    <button type="button" className="day-links__note" title={rel} onClick={() => open(rel)}>
      {nameOf(rel)}
    </button>
  );
  const first = pairs[0];
  const citeText = cites > 0 ? t.home_links_cites.replace("{n}", String(cites)) : null;
  return (
    <p className="day-links">
      {first ? (
        <>
          {t.home_links_today} {note(first[0])} ↔ {note(first[1])}
          {pairs.length > 1 ? t.home_links_more.replace("{n}", String(pairs.length - 1)) : null}
          {citeText ? ` · ${citeText}` : null}
        </>
      ) : (
        (citeText ?? t.home_links_none)
      )}
      <small className="day-links__when">{t.home_links_updated}</small>
    </p>
  );
}
