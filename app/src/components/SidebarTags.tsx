// The sidebar's Tags group (UX backlog S23): folded by default, it lists the
// vault's most used tags with their counts. A tag opens ⌘K filtered to it —
// no route of its own.

import { useMemo } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { tagCounts } from "../lib/tagIndex";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { Icon } from "../lib/icons";
import { openCommandBar } from "./CommandBar";

// Its open state lives with the folders' (uiStore.expandedFolders).
const TAGS_ID = "__tags";
const TOP = 12;

export default function SidebarTags({ t }: { t: Strings }): JSX.Element | null {
  const tags = useVaultStore((s) => s.adjacency?.tags);
  const open = useUIStore((s) => s.expandedFolders[TAGS_ID] ?? false);
  const toggleFolder = useUIStore((s) => s.toggleFolder);
  const all = useMemo(() => tagCounts(tags ?? {}), [tags]);
  // No tags (or no index yet): the group would only say so.
  if (all.length === 0) return null;
  return (
    <div className="nav-group">
      <button className="nav-item" aria-expanded={open} onClick={() => toggleFolder(TAGS_ID)}>
        <span className={"ni-caret" + (open ? " open" : "")}>
          <Icon name="chevR" size={10} />
        </span>
        <span className="ni-icon" aria-hidden="true">
          #
        </span>
        <span className="ni-text">{t.sb_tags}</span>
        <span className="ni-count">{all.length.toLocaleString()}</span>
      </button>
      {open ? (
        <div className="sb-tags">
          {all.slice(0, TOP).map(([tag, n]) => (
            <button
              key={tag}
              type="button"
              className="pill sb-tag"
              aria-label={t.sb_tag_chip.replace("{tag}", tag).replace("{n}", String(n))}
              onClick={() => openCommandBar(`tag:${tag} `)}
            >
              <span className="sb-tag__name">#{tag}</span>
              <span className="sb-tag__n" aria-hidden="true">
                {n.toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
