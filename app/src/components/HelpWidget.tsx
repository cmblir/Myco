// Help widget — the quiet "?" in the bottom-right corner. PULL, not push:
// the button never animates, never opens itself, never nags (the Clippy
// post-mortem in one sentence). Clicking it opens a small panel where MYCO
// greets you next to the tips for the CURRENT page plus the global keyboard
// shortcuts. Hidden in graph-fullscreen (ship mode owns the frame then).

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import MascotClip from "./MascotClip";

/** Route → i18n tip keys (fallback English inline). Curated, short, static. */
function tipsFor(route: string, t: Strings): string[] {
  const base = route.startsWith("page:") ? "reader" : route;
  switch (base) {
    case "graph":
      return [
        t.hw_tip_graph1 ?? "Drag a star and the simulation re-heats around it.",
        t.hw_tip_graph2 ?? "F flies the spaceship; the ⚠ badge opens gap analysis with research bridges.",
        t.hw_tip_graph3 ?? "Near-field planets (settings drawer) turn close-up notes into worlds.",
      ];
    case "query":
      return [
        t.hw_tip_query1 ?? "Answers cite wiki pages — click a citation to open it.",
        t.hw_tip_query2 ?? "The graph's gap panel can draft research questions into this box.",
      ];
    case "ingest":
      return [
        t.hw_tip_ingest1 ?? "Drop any file, paste text, or import a Zotero export.",
        t.hw_tip_ingest2 ?? "The web clipper sends pages here through _inbox/ (see clipper/).",
      ];
    case "views":
      return [
        t.hw_tip_views1 ?? "Filters compose — save the result as a named view chip.",
      ];
    case "overview":
      return [
        t.hw_tip_overview1 ?? "Suggested links are semantic pairs with no wikilink yet — accept or dismiss.",
      ];
    default:
      return [t.hw_tip_default ?? "⌘K jumps anywhere — pages, actions, semantic hits."];
  }
}

export default function HelpWidget({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const [open, setOpen] = useState(false);

  // Esc closes the panel (matches every other overlay in the app).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The app registers far more than the four keys this list used to admit to,
  // so half of them were effectively undiscoverable. Only the ones a user can
  // press from anywhere (or on the page they are already looking at) belong
  // here — panel-local keys stay documented by the panel that owns them.
  const shortcuts: [string, string][] = [
    ["⌘K", t.hw_sc_cmd ?? "Command palette"],
    ["⌘B", t.hw_sc_sidebar ?? "Toggle sidebar"],
    ["⌘[", t.hw_sc_back ?? "Back"],
    ["⌘]", t.hw_sc_fwd ?? "Forward"],
    ["⌘N", t.hw_sc_new ?? "New note"],
    ["⌥Space", t.hw_sc_spotlight ?? "Ask from anywhere"],
    ["⌥M", t.hw_sc_voice ?? "Voice capture (Spotlight / notch)"],
    ["⌥⏎", t.hw_sc_miss ?? "Log a search that missed"],
    ["Esc", t.hw_sc_esc ?? "Close / deselect"],
    [
      "⌘click",
      t.hw_sc_live_link ?? "Open the wikilink under the pointer (Live editor)",
    ],
  ];
  const graphShortcuts: [string, string][] = [
    ["F", t.hw_sc_fly ?? "Fly mode (graph)"],
    ["⌘click", t.hw_sc_path ?? "Shortest path between two notes (graph)"],
  ];

  return (
    <>
      {open ? (
        <div className="help-widget__panel" role="dialog" aria-label={t.hw_title ?? "Help"}>
          <div className="help-widget__head">
            <MascotClip clip="idle" size={56} />
            <div>
              <div className="help-widget__title">{t.hw_title ?? "Help"}</div>
              <div className="muted help-widget__sub">
                {t.hw_sub ?? "Tips for this page"}
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setOpen(false)}
              aria-label={t.ui_close ?? "Close"}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
          <ul className="help-widget__tips">
            {tipsFor(route, t).map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          <div className="help-widget__sc">
            {/* Graph keys only where they can be pressed — listing fly mode on
                the Tasks page is noise, and hiding it on the graph is the bug
                this list had. */}
            {[...shortcuts, ...(route === "graph" ? graphShortcuts : [])].map(
              ([key, label]) => (
                <div key={key} className="help-widget__sc-row">
                  <kbd>{key}</kbd>
                  <span>{label}</span>
                </div>
              ),
            )}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        className="help-widget__fab"
        aria-label={t.hw_title ?? "Help"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
    </>
  );
}
