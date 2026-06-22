// PageReader: opens a vault file via real IPC. Source mode uses CodeMirror,
// preview mode renders markdown-it (with wikilinks). The `sample/<id>`
// pseudo-route falls through to the design's mock content.

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { SAMPLE } from "../lib/sample";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import Editor from "../components/Editor";
import Viewer from "../components/Viewer";
import BacklinksPanel from "../components/BacklinksPanel";

const AUTOSAVE_MS = 2000;

export default function PageReader({
  t,
  pageRoute,
}: {
  t: Strings;
  pageRoute: string;
}): JSX.Element {
  if (pageRoute.startsWith("sample/")) {
    return <SamplePage id={pageRoute.slice(7)} />;
  }
  return <VaultPage key={pageRoute} path={pageRoute} t={t} />;
}

function SamplePage({ id }: { id: string }): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const p = SAMPLE.pages.find((x) => x.id === id) ?? SAMPLE.pages[0];
  const md =
    SAMPLE.pageContents[id] ??
    `# ${p.title}\n\n_(Sample preview — open a real .md from the sidebar to edit.)_`;
  const lines = md.split("\n");

  function renderInline(s: string): JSX.Element[] {
    const parts = s.split(/(\[\[[^\]]+\]\]|<cite n="\d+"\/>)/g);
    return parts.map((part, i) => {
      const wm = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(part);
      const cm = /^<cite n="(\d+)"\/>$/.exec(part);
      if (wm) {
        return (
          <button
            key={i}
            className="wikilink"
            onClick={() => setRoute(`page:sample/${wm[1]}`)}
            style={{
              background: "transparent",
              border: 0,
              color: "inherit",
              padding: 0,
            }}
          >
            {wm[2] ?? wm[1]}
          </button>
        );
      }
      if (cm)
        return (
          <span key={i} className="cite-pill">
            {cm[1]}
          </span>
        );
      // Escape HTML before the inline-markdown substitutions so this stays safe
      // even if it is ever pointed at non-static content (today it only renders
      // the bundled SAMPLE constant).
      const html = part
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/_([^_]+)_/g, "<i>$1</i>");
      return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
    });
  }

  return (
    <div className="workspace">
      <header className="page-head" style={{ paddingTop: 40 }}>
        <div className="row" style={{ marginBottom: 16 }}>
          <span className="typebadge">
            <span className={`tb-dot t-${p.type}`}></span>
            {p.type}
          </span>
          <span className="muted" style={{ fontSize: 12.5 }}>
            updated {p.updated} · {p.words} words · {p.links} links
          </span>
        </div>
        <h1 className="page-title">{p.title}</h1>
      </header>
      <div className="prose">
        {lines.map((line, i) => {
          if (!line.trim()) return <div key={i} style={{ height: 8 }}></div>;
          if (line.startsWith("# "))
            return <h1 key={i}>{renderInline(line.slice(2))}</h1>;
          if (line.startsWith("## "))
            return <h2 key={i}>{renderInline(line.slice(3))}</h2>;
          if (line.startsWith("### "))
            return <h3 key={i}>{renderInline(line.slice(4))}</h3>;
          if (/^\d+\. /.test(line))
            return (
              <p key={i} style={{ paddingLeft: 16 }}>
                <b>{/^\d+/.exec(line)?.[0]}.</b>{" "}
                {renderInline(line.replace(/^\d+\. /, ""))}
              </p>
            );
          if (line.startsWith("- "))
            return (
              <p key={i} style={{ paddingLeft: 16 }}>
                · {renderInline(line.slice(2))}
              </p>
            );
          return <p key={i}>{renderInline(line)}</p>;
        })}
      </div>
    </div>
  );
}

function VaultPage({ path }: { path: string; t: Strings }): JSX.Element {
  const openFile = useVaultStore((s) => s.openFile);
  const activeFile = useVaultStore((s) => s.activeFile);
  const currentVaultPath = useVaultStore((s) => s.currentVault?.path);
  const saveFile = useVaultStore((s) => s.saveFile);
  const resolveWikilink = useVaultStore((s) => s.resolveWikilink);
  const refreshTree = useVaultStore((s) => s.refreshTree);
  const error = useVaultStore((s) => s.error);
  const setRoute = useUIStore((s) => s.setRoute);
  const [mode, setMode] = useState<"preview" | "source" | "split">("split");
  const [draft, setDraft] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest editor text, so the unmount cleanup can flush edits made inside the
  // debounce window. We compare it against the store's on-disk `raw` rather than
  // a dirty flag: a flag is unreliable because a save can resolve (clearing it)
  // while newer keystrokes are still pending, which would drop those keystrokes.
  const draftRef = useRef("");
  // The path we have already seeded the editor from. We seed ONCE per file —
  // reseeding on every activeFile change would let a self-initiated save (which
  // updates activeFile.raw) clobber keystrokes typed during that save.
  const seededPathRef = useRef<string | null>(null);
  // The on-disk baseline we last seeded/persisted for THIS file. The unmount
  // flush compares the draft against this component-local value (not the global
  // activeFile, which a rename/interleaved openFile can move off this path before
  // we flush) so unsaved keystrokes are never dropped on navigation.
  const seededRawRef = useRef("");

  // Re-open when the vault finishes loading too: on a cold launch / deep-link
  // straight to a page route, App's auto-restore runs openVault (which resets
  // activeFile to null) *after* this effect's first openFile, blanking the
  // page. Re-running once currentVault is set restores the file.
  useEffect(() => {
    void openFile(path);
  }, [path, openFile, currentVaultPath]);

  useEffect(() => {
    if (activeFile?.path === path && seededPathRef.current !== path) {
      seededPathRef.current = path;
      // Seed from `raw` (the full file incl. frontmatter), not the stripped
      // `content`, so editing + autosave round-trips the frontmatter losslessly.
      setDraft(activeFile.raw);
      draftRef.current = activeFile.raw;
      seededRawRef.current = activeFile.raw;
    }
  }, [activeFile?.path, activeFile?.raw, path]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // Flush unsaved edits on navigation/unmount regardless of the timer state.
      // Compare the draft against the component-local baseline (seededRawRef),
      // NOT the global activeFile: a rename / delete / interleaved openFile can
      // move activeFile off this path before this cleanup runs, and gating on it
      // would silently drop the pending keystrokes for this file.
      if (draftRef.current !== seededRawRef.current) {
        void saveFile(path, draftRef.current);
        seededRawRef.current = draftRef.current;
      }
    },
    [path, saveFile],
  );

  function scheduleSave(c: string): void {
    draftRef.current = c;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      seededRawRef.current = c;
      void saveFile(path, c);
    }, AUTOSAVE_MS);
  }
  function flushSave(c: string): void {
    draftRef.current = c;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    seededRawRef.current = c;
    void saveFile(path, c);
  }

  if (!activeFile || activeFile.path !== path) {
    return (
      <div className="workspace">
        <p className="muted" style={{ paddingTop: 80 }}>
          {error ?? "Loading…"}
        </p>
      </div>
    );
  }

  const fileName = path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="workspace">
      <header className="page-head" style={{ paddingTop: 40 }}>
        <div className="row" style={{ marginBottom: 16, gap: 12 }}>
          <span className="typebadge">
            <span className="tb-dot t-overview"></span>
            file
          </span>
          <span
            className="muted"
            style={{
              fontSize: 12.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
            title={path}
          >
            {path}
          </span>
          <div className="segmented">
            <button
              className={mode === "source" ? "active" : ""}
              onClick={() => setMode("source")}
            >
              <Icon name="edit" size={12} /> Source
            </button>
            <button
              className={mode === "split" ? "active" : ""}
              onClick={() => setMode("split")}
            >
              <Icon name="sidebar" size={12} /> Split
            </button>
            <button
              className={mode === "preview" ? "active" : ""}
              onClick={() => setMode("preview")}
            >
              <Icon name="eye" size={12} /> Preview
            </button>
          </div>
        </div>
        <h1 className="page-title">{fileName.replace(/\.md$/i, "")}</h1>
      </header>
      <section
        style={{
          display: "flex",
          flexDirection: mode === "split" ? "row" : "column",
          gap: mode === "split" ? 16 : 0,
          minHeight: "60vh",
        }}
      >
        {mode !== "preview" ? (
          <div style={{ flex: 1, minHeight: "60vh", display: "flex" }}>
            <Editor
              docKey={path}
              initialValue={activeFile.raw}
              onChange={(c) => {
                setDraft(c);
                scheduleSave(c);
              }}
              onSave={(c) => flushSave(c)}
            />
          </div>
        ) : null}
        {mode !== "source" ? (
          <div className="prose" style={{ flex: 1 }}>
            <Viewer
              content={draft}
              onLinkClick={(target) => {
                const resolved = resolveWikilink(target);
                if (resolved) {
                  setRoute(`page:${resolved}`);
                  return;
                }
                // Unresolved link: create the note next to the current file
                // and open it (Obsidian-style create-on-click), instead of a
                // silent no-op.
                void (async () => {
                  const dir = path.replace(/[\\/][^\\/]+$/, "");
                  const name = `${target.replace(/[\\/]/g, "-")}.md`;
                  try {
                    const created = await ipc.createFile(dir, name);
                    await refreshTree();
                    setRoute(`page:${created}`);
                  } catch {
                    /* already exists or invalid name — ignore */
                  }
                })();
              }}
            />
          </div>
        ) : null}
      </section>
      <BacklinksPanel filePath={path} />
    </div>
  );
}
