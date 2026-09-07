// The reader's one rail (mockup "Manuscript"): properties → outline →
// sources & trust → connections, in that order. Stateless — every section owns
// its own data; this only decides the stack.
//
// Each section is a shared <Rail>, the same part the graph's gaps column and
// legend are built from, so the three rails in the app are one implementation.

import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import type { FmPatch, Frontmatter } from "../lib/frontmatter";
import type { OutlineHeading } from "../lib/outline";
import type { LinkSuggestionIO } from "../lib/linkSuggestions";
import Rail from "./Rail";
import PropertiesPanel from "./PropertiesPanel";
import OutlinePanel from "./OutlinePanel";
import SourcesPanel from "./SourcesPanel";
import ConnectionsPanel from "./ConnectionsPanel";

export default function ReaderRail({
  filePath,
  fm,
  allTags,
  onPatch,
  headings,
  onSelectHeading,
  io,
  /** raw/ is immutable: no property form, no accepting links into it. */
  readOnly,
  t,
}: {
  filePath: string;
  fm: Frontmatter | null;
  allTags: string[];
  onPatch: (p: FmPatch) => void;
  headings: OutlineHeading[];
  onSelectHeading: (h: OutlineHeading) => void;
  io: LinkSuggestionIO;
  readOnly: boolean;
  t: Strings;
}): JSX.Element {
  return (
    <aside className="reader-rail" aria-label={t.rd_rail ?? "Note rail"}>
      {readOnly ? null : (
        <PropertiesPanel fm={fm} allTags={allTags} onPatch={onPatch} t={t} />
      )}
      <Rail
        title={t.ol_title ?? "Outline"}
        count={headings.length > 0 ? headings.length : undefined}
      >
        <OutlinePanel t={t} headings={headings} onSelect={onSelectHeading} />
      </Rail>
      <SourcesPanel filePath={filePath} t={t} />
      <ConnectionsPanel filePath={filePath} io={io} t={t} />
    </aside>
  );
}
