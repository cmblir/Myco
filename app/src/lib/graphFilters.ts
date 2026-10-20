// The graph's corpus filters as the bar sees them. They are set in the
// settings drawer and persisted with the rest of the settings, so with the
// drawer closed a vault that suddenly showed two notes gave no hint why, and
// a filter that matched nothing left a bare stage with no way back. Pure so
// the bar's chips and the empty state's "clear filters" are testable in node.

import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from "./graphSettings";
import type { Strings } from "./i18n";

/** Everything computeAllowed and the sample switch read, back at its default. */
export function clearFilters(): Pick<
  GraphSettings,
  "search" | "tagFilter" | "folderFilter" | "existingOnly" | "showOrphans" | "hideSample"
> {
  const d = DEFAULT_GRAPH_SETTINGS;
  return {
    search: "",
    tagFilter: null,
    folderFilter: null,
    existingOnly: d.existingOnly,
    showOrphans: d.showOrphans,
    hideSample: d.hideSample,
  };
}

export interface FilterChip {
  key: "tag" | "folder" | "search";
  label: string;
  /** The patch that lifts just this filter. */
  clear: Partial<GraphSettings>;
}

/**
 * The narrowing filters that live only in the drawer, as removable chips.
 * The sample and unresolved switches are already visible on the bar as
 * checks, so they are not repeated here.
 */
export function activeFilterChips(s: GraphSettings, t: Strings): FilterChip[] {
  const chips: FilterChip[] = [];
  if (s.tagFilter) chips.push({ key: "tag", label: `#${s.tagFilter}`, clear: { tagFilter: null } });
  if (s.folderFilter) {
    chips.push({
      key: "folder",
      label: t.gr_filter_folder.replace("{f}", s.folderFilter),
      clear: { folderFilter: null },
    });
  }
  const q = s.search.trim();
  if (q) chips.push({ key: "search", label: t.gr_filter_search.replace("{q}", q), clear: { search: "" } });
  return chips;
}
