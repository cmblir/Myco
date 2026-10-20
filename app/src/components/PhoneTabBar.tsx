// The phone shell's bottom bar (UX S50, mobile-strategy "모바일 정보 구조"):
// Home, My notes, Add sources, Ask — the everyday moves under the thumb
// instead of behind the drawer at the top left. Shown only at <=768px
// (styles.css); wider windows keep the sidebar.

import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";

export default function PhoneTabBar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const setRoute = useUIStore((s) => s.setRoute);
  const drawerOpen = useUIStore((s) => !s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);

  const go = (to: RouteId, label: string, icon: IconName): JSX.Element => (
    <button
      type="button"
      className="phone-tabbar__item"
      aria-current={route === to ? "page" : undefined}
      onClick={() => {
        setSidebarCollapsed(true);
        setRoute(to);
      }}
    >
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );

  return (
    <nav className="phone-tabbar" aria-label={t.tabbar_label}>
      {go("overview", t.nav_overview, "home")}
      <button
        type="button"
        className="phone-tabbar__item"
        aria-expanded={drawerOpen}
        onClick={() => setSidebarCollapsed(drawerOpen)}
      >
        <Icon name="sidebar" size={20} />
        <span>{t.nav_pages}</span>
      </button>
      {go("ingest", t.nav_ingest, "plus")}
      {go("query", t.nav_query, "msg")}
    </nav>
  );
}
