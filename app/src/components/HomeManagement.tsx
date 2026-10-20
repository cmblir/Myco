// Mounted only while Home's workspace tools are open. Closing the disclosure
// releases their scans, layout subscriptions, observers, and widget effects.
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import type { DayBuckets } from "../lib/vaultPulse";
import { useUIStore } from "../stores/uiStore";
import { Button } from "./ui";
import HarvestQueue from "./HarvestQueue";
import LinkSuggestions from "./LinkSuggestions";
import { useMorningPanels } from "./MorningBand";
import OverviewBoard from "./OverviewBoard";
import {
  OverviewZoneBlocks,
  useOverviewArrange,
  type OverviewNodes,
} from "./OverviewArrange";
import VaultHistoryBanner from "./VaultHistoryBanner";
import VaultPulse from "./VaultPulse";

interface HomeManagementProps {
  t: Strings;
  vaultPath: string;
  pulse: { files: number; links: number };
  buckets: DayBuckets;
  recent: JSX.Element;
  distill: JSX.Element;
  reflect: JSX.Element;
}

export default function HomeManagement({
  t,
  vaultPath,
  pulse,
  buckets,
  recent,
  distill,
  reflect,
}: HomeManagementProps): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const panels = useMorningPanels(t);
  const arrange = useOverviewArrange(t, vaultPath);
  const blocks: OverviewNodes = {
    pulse: (
      <VaultPulse
        t={t}
        pages={pulse.files}
        links={pulse.links}
        buckets={buckets}
      />
    ),
    harvest: <HarvestQueue t={t} />,
    links: <LinkSuggestions t={t} />,
    recent,
    board: <OverviewBoard t={t} />,
    contradictions: panels.contradictions,
    reunions: panels.reunions,
  };

  return (
    <>
      <div className="home-management-tools">
        {arrange.arranging ? <Button onClick={arrange.reset}>{t.ovl_reset}</Button> : null}
        <Button
          variant={arrange.arranging ? "primary" : undefined}
          onClick={() => arrange.setArranging(!arrange.arranging)}
          aria-pressed={arrange.arranging}
        >
          {arrange.arranging ? t.ovl_done : t.ovl_edit}
        </Button>
        <Button onClick={() => setRoute("history")}>{t.ov_view_runs}</Button>
      </div>
      <VaultHistoryBanner t={t} />
      {arrange.arranging ? <p className="u-page__note">{t.ovl_hint}</p> : null}
      <p className="ovl-live" aria-live="polite" role="status">{arrange.announcement}</p>
      <OverviewZoneBlocks ctl={arrange} nodes={blocks} t={t} />
      <div className="ov-bands">
        <section>
          <div className="section-head"><div className="section-title">{t.s_distill}</div></div>
          <div className="card-grid">{distill}</div>
        </section>
      </div>
      {reflect}
    </>
  );
}
