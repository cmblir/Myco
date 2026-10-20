// The notices bell in Home's title row (spec 2026-10-02, decisions 2-3): what
// used to be the right rail's three panels, as one popover. The badge counts
// notice rows — the same number the sidebar's Home row shows (noticeBadge).
// The popover keeps the modal focus contract (useModalFocus: focus in, Tab
// kept inside, Escape closes) and closes on a click outside it.

import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { FOCUSABLE } from "../lib/focusTrap";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { stem } from "../lib/graphData";
import {
  checkItems,
  NOTICE_ITEMS,
  noticeBadge,
  plainCheckReason,
  type HomeNotice,
  type NoticeItem,
} from "../lib/overviewReport";
import { useHomeNotices, useNoticesStore } from "../stores/noticesStore";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useModalFocus } from "./useModalFocus";
import { Button, IconButton } from "./ui";

const TITLE: Record<HomeNotice["kind"], keyof Strings> = {
  changes: "hn_changes",
  check: "hn_check",
  contradictions: "hn_contra",
};

export default function HomeNotices({ t }: { t: Strings }): JSX.Element {
  const notices = useHomeNotices();
  const status = useNoticesStore((s) => s.status);
  const suspects = useNoticesStore((s) => s.suspects);
  const vault = useVaultStore((s) => s.currentVault?.path ?? "");
  const lang = useUIStore((s) => s.lang);
  const [open, setOpen] = useState(false);
  // "See all" opens the whole check list in place: no other screen lists the
  // suspect scan, and the popover already scrolls.
  const [expanded, setExpanded] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const popId = useId();
  const fmt = new Intl.NumberFormat(lang);
  const badge = noticeBadge(notices, t, lang);
  const label = badge?.label ?? t.hn_label;

  // A click does not focus a button in WebKit, so the opener useModalFocus
  // remembers can be <body>: Escape puts focus back on the bell itself. With
  // nothing to report the popover holds no control, so focus goes to the
  // popover itself — Escape has to reach it.
  const { onKeyDown } = useModalFocus(pop, {
    open,
    onEscape: () => {
      setOpen(false);
      bell.current?.focus();
    },
    initial: () => pop.current?.querySelector<HTMLElement>(FOCUSABLE) ?? pop.current,
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The see-all button goes away once pressed; focus moves to the first row it
  // revealed, so it stays inside the popover (Tab trap, Escape).
  useEffect(() => {
    if (!expanded) return;
    pop.current
      ?.querySelector<HTMLElement>(`[data-kind="check"] li:nth-child(${NOTICE_ITEMS + 1}) button`)
      ?.focus();
  }, [expanded]);

  const go = (route: RouteId): void => {
    setOpen(false);
    useUIStore.getState().setRoute(route);
  };
  const openNote = (rel: string): void => go(`page:${vault}/${rel}`);
  const items = (n: HomeNotice): NoticeItem[] =>
    n.kind === "contradictions"
      ? []
      : n.kind === "check" && expanded && suspects
        ? checkItems(suspects, Infinity)
        : n.items;
  const quiet = status === "idle" || status === "loading";

  return (
    <div className="home-bell" ref={wrap}>
      <IconButton
        ref={bell}
        className="home-bell__btn"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => {
          setOpen(!open);
          setExpanded(false);
        }}
      >
        <Icon name="bell" size={18} />
        {badge ? (
          <span className="home-bell__count" aria-hidden="true">
            {badge.count}
          </span>
        ) : null}
      </IconButton>
      {open ? (
        <div
          id={popId}
          ref={pop}
          className="home-bell__pop"
          role="dialog"
          aria-label={t.hn_label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <h2 className="home-bell__title">{t.hn_label}</h2>
          {status === "error" ? (
            <div className="home-bell__state" role="alert">
              <span>{t.hn_error}</span>
              <Button onClick={() => void useNoticesStore.getState().load(vault)}>
                {t.home_retry}
              </Button>
            </div>
          ) : null}
          {notices.length === 0 && status !== "error" ? (
            <p className="home-bell__state" role="status">
              {quiet ? t.hn_loading : t.hn_empty}
            </p>
          ) : null}
          {notices.length > 0 ? (
            <ul className="home-bell__list">
              {notices.map((n) => (
                <li key={n.kind} className="home-bell__notice" data-kind={n.kind}>
                  <p className="home-bell__head">
                    <span>{t[TITLE[n.kind]] as string}</span>
                    <span className="home-bell__n">{fmt.format(n.count)}</span>
                  </p>
                  {items(n).length > 0 ? (
                    <ul className="home-bell__items">
                      {items(n).map((item) => (
                        <li key={item.rel}>
                          {/* The name, not the path; the path stays in the title. */}
                          <button type="button" title={item.rel} onClick={() => openNote(item.rel)}>
                            <span className="home-bell__name">{stem(item.rel)}</span>
                            {item.reason !== undefined ? (
                              <span className="home-bell__why">{plainCheckReason(item.reason, t)}</span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {n.kind === "check" && n.count > items(n).length ? (
                    <Button variant="quiet" onClick={() => setExpanded(true)}>
                      {t.hn_see_all}
                    </Button>
                  ) : null}
                  {n.kind === "contradictions" ? (
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setOpen(false);
                        // Home's own panel holds the resolve buttons.
                        useUIStore.getState().focusSection("contradictions");
                      }}
                    >
                      {t.hn_contra_open}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
