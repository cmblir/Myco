// Tags page (FEAT-03) — groups every vault page by its frontmatter tags
// (from the vault store's adjacency.tags: absolute path -> string[]). Shows a
// tag cloud with counts; picking a tag filters to the pages carrying it, and
// picking a page opens it in the reader.

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

interface TagGroup {
  tag: string;
  paths: string[];
}

export default function PageTags({ t }: { t: Strings }): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const adjacency = useVaultStore((s) => s.adjacency);
  const [selected, setSelected] = useState<string | null>(null);

  // tag -> sorted unique page paths, sorted by descending page count then name.
  const groups = useMemo<TagGroup[]>(() => {
    const byTag = new Map<string, Set<string>>();
    const tags = adjacency?.tags ?? {};
    for (const [path, list] of Object.entries(tags)) {
      for (const raw of list) {
        const tag = raw.trim();
        if (!tag) continue;
        let set = byTag.get(tag);
        if (!set) {
          set = new Set();
          byTag.set(tag, set);
        }
        set.add(path);
      }
    }
    return [...byTag.entries()]
      .map(([tag, paths]) => ({ tag, paths: [...paths].sort() }))
      .sort((a, b) => b.paths.length - a.paths.length || a.tag.localeCompare(b.tag));
  }, [adjacency]);

  const activeGroup = useMemo(
    () => (selected ? groups.find((g) => g.tag === selected) : undefined),
    [groups, selected],
  );

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_tags}</div>
        <h1 className="page-title">{t.tg_title}</h1>
        <p className="page-lede">{t.tg_lede}</p>
      </header>

      {groups.length === 0 ? (
        <p className="muted">{t.tg_empty}</p>
      ) : (
        <>
          <div
            className="row"
            style={{ marginTop: 16, flexWrap: "wrap", gap: 8 }}
          >
            <button
              className={"chip" + (selected === null ? " active" : "")}
              style={{
                cursor: "pointer",
                border: "1px solid var(--line)",
                background: selected === null ? "var(--ink)" : "transparent",
                color: selected === null ? "var(--bg)" : "var(--ink)",
              }}
              onClick={() => setSelected(null)}
            >
              {t.gr_all}
            </button>
            {groups.map((g) => {
              const on = g.tag === selected;
              return (
                <button
                  key={g.tag}
                  className={"chip" + (on ? " active" : "")}
                  style={{
                    cursor: "pointer",
                    border: "1px solid var(--line)",
                    background: on ? "var(--ink)" : "transparent",
                    color: on ? "var(--bg)" : "var(--ink)",
                  }}
                  onClick={() => setSelected(on ? null : g.tag)}
                >
                  <Icon name="book" size={12} /> {g.tag}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>
                    {g.paths.length}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="section-head">
            <div className="section-title" style={{ fontSize: 14 }}>
              {activeGroup ? activeGroup.tag : t.gr_all}
            </div>
          </div>
          <div className="list">
            {(activeGroup ? activeGroup.paths : allPaths(groups)).map((path) => (
              <button
                key={path}
                className="list-row"
                style={{
                  gridTemplateColumns: "20px 1fr auto",
                  background: "transparent",
                  border: 0,
                  textAlign: "left",
                }}
                onClick={() => setRoute(`page:${path}`)}
              >
                <span className="ic">
                  <Icon name="page" size={13} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {pageName(path)}
                  </div>
                  <div
                    className="muted"
                    style={{
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {path}
                  </div>
                </div>
                <span className="ic">
                  <Icon name="chevR" size={12} />
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Union of every page path across all tag groups (sorted, de-duplicated). */
function allPaths(groups: TagGroup[]): string[] {
  const set = new Set<string>();
  for (const g of groups) for (const p of g.paths) set.add(p);
  return [...set].sort();
}

function pageName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.md$/i, "");
}
