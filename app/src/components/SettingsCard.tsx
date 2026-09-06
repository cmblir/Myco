// One settings card, wired to the row registry.
//
// This is what replaced the MutationObserver: the card asks the registry
// whether it matches the current search instead of the search reading the
// card's rendered text back out of the DOM. Same criterion as the tab rail
// (settingsSearch.matchSettings), so a tab can no longer disappear while a
// matching card sits inside it.
//
// A card whose id the registry does not know always renders — the filter
// never hides a control it has never heard of.

import { createContext, useContext } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { isRowVisible } from "../lib/settingsSearch";
import type { SettingsRow } from "../lib/settingsSearch";

export interface SettingsFilter {
  /** Row ids that survive the current query + changed-only toggle. */
  matched: ReadonlySet<string>;
  /** The resolved row, for the inline value at the end of the line. */
  row: (id: string) => SettingsRow | undefined;
}

/** null = no filtering (a panel rendered outside the Settings page). */
export const SettingsFilterContext = createContext<SettingsFilter | null>(null);

export function SettingsCard({
  id,
  className = "card",
  style,
  hideValue,
  children,
}: {
  /** Registry row id (see lib/settingsSearch). */
  id: string;
  className?: string;
  style?: CSSProperties;
  /** For the few cards whose own header already prints the value. */
  hideValue?: boolean;
  children: ReactNode;
}): JSX.Element | null {
  const filter = useContext(SettingsFilterContext);
  if (filter && !isRowVisible(id, filter.matched)) return null;
  const row = hideValue ? undefined : filter?.row(id);
  return (
    // The value rides in an absolutely positioned corner chip so wrapping a
    // card in this changes no card's own layout (several are grids).
    <div className={className} style={style} data-srow={id}>
      {row?.value ? (
        <span className={"s-rowval" + (row.changed ? " is-changed" : "")}>
          {row.value}
        </span>
      ) : null}
      {children}
    </div>
  );
}
