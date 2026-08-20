// Feedback — the pending distill-proposal inbox (Task 9, Phase A) plus the
// quarantine review tab (ROADMAP P0). Tab one surfaces what Task 6/7's idle
// run left in work/feedback/*.md: emerging clusters to admit, stale batches to
// archive or delete. Tab two lists _inbox/quarantine/ — items the admission
// gate held back, which until now only ever showed up as a count. Every action
// on both tabs delegates to distillStore; this page is presentational plus the
// confirm dialogs.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import { useDistillStore } from "../stores/distillStore";
import type { ProposalAction, ProposalMeta } from "../stores/distillStore";
import { confirmAction } from "../stores/dialogStore";
import { daysLeft, verdictSentence, KEEP_DAYS } from "../lib/quarantine";
import type { QuarantineItem } from "../lib/quarantine";
import Viewer from "../components/Viewer";

function kindLabel(t: Strings, action: ProposalAction): string {
  if (action === "admit-cluster") return t.pf_kind_admit ?? "Admit cluster";
  if (action === "archive-batch") return t.pf_kind_archive ?? "Archive batch";
  if (action === "draft-map") return t.pf_kind_draft_map ?? "Draft topic map";
  return t.pf_kind_delete ?? "Delete batch";
}

/** The TTL line: how long this item still has before the distill run's own TTL
 *  pass becomes eligible to trash it. A malformed sidecar has no expiry at all
 *  — say so rather than implying it is safe forever. */
function ttlLine(item: QuarantineItem, t: Strings): string {
  const left = daysLeft(item);
  if (left === null) return t.qz_expires_unknown ?? "No expiry recorded";
  if (left === 0)
    return t.qz_expires_due ?? "Expired — the next run may move it to trash";
  return (t.qz_expires_in ?? "{n} days left").replace("{n}", String(left));
}

function QuarantineTab({ t }: { t: Strings }): JSX.Element {
  const items = useDistillStore((s) => s.quarantine);
  const restore = useDistillStore((s) => s.restoreQuarantine);
  const trash = useDistillStore((s) => s.trashQuarantine);
  const keep = useDistillStore((s) => s.keepQuarantine);
  // Which item currently has an action in flight — disables that card's three
  // buttons so a double click can't fire two moves at the same file.
  const [busy, setBusy] = useState<string | null>(null);

  async function act(path: string, run: () => Promise<void>): Promise<void> {
    setBusy(path);
    try {
      await run();
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(item: QuarantineItem): Promise<void> {
    const ok = await confirmAction({
      title: t.qz_confirm_delete_title ?? "Delete this item?",
      message: (
        t.qz_confirm_delete_msg ??
        "{name} goes to the system trash (recoverable from there)."
      ).replace("{name}", item.name),
    });
    if (!ok) return;
    await act(item.path, () => trash(item.path));
  }

  if (items.length === 0) {
    return (
      <p className="muted" style={{ marginTop: 16 }}>
        {t.qz_empty ?? "Nothing in quarantine."}
      </p>
    );
  }

  return (
    <div className="col" style={{ gap: 12, marginTop: 16 }}>
      <p className="muted" style={{ fontSize: 12.5 }}>
        {t.qz_lede ??
          "Items the admission gate judged off-topic. They are held, not deleted — restore what belongs, trash what doesn't."}
      </p>
      {items.map((item) => (
        <div key={item.path} className="card" data-testid="quarantine-item">
          <div style={{ fontWeight: 600 }}>{item.name}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            {verdictSentence(item, t)} · {ttlLine(item, t)}
          </div>
          {item.preview ? (
            <p
              className="muted"
              style={{
                fontSize: 12.5,
                marginTop: 8,
                // Two lines of the body is enough to recognise a note by; the
                // full text is one restore (or a click in the sidebar) away.
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {item.preview}
            </p>
          ) : null}
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === item.path}
              onClick={() => void act(item.path, () => restore(item.path))}
            >
              {t.qz_restore ?? "Restore to vault"}
            </button>
            <button
              type="button"
              className="btn-ghost btn"
              disabled={busy === item.path}
              onClick={() =>
                void act(item.path, () => keep(item.path, KEEP_DAYS))
              }
            >
              {(t.qz_keep ?? "Keep {n} more days").replace(
                "{n}",
                String(KEEP_DAYS),
              )}
            </button>
            <button
              type="button"
              className="btn-ghost btn"
              disabled={busy === item.path}
              onClick={() => void handleDelete(item)}
            >
              {t.qz_delete ?? "Delete"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PageFeedback({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const tab = useUIStore((s) => s.feedbackTab);
  const setTab = useUIStore((s) => s.setFeedbackTab);
  const proposals = useDistillStore((s) => s.proposals);
  const quarantineCount = useDistillStore((s) => s.quarantine.length);
  const loading = useDistillStore((s) => s.loading);
  const error = useDistillStore((s) => s.error);
  const refresh = useDistillStore((s) => s.refresh);
  const apply = useDistillStore((s) => s.apply);
  const dismiss = useDistillStore((s) => s.dismiss);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [result, setResult] = useState<{ path: string; summary: string } | null>(null);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVault]);

  // Approve AND retry (an `approved`-status proposal whose previous
  // applyDistillProposal call failed) both go through this — the store's
  // apply() itself decides whether the pending->approved rewrite still needs
  // to happen, so the confirm-then-apply flow here doesn't need to know which
  // case it's in.
  async function handleApprove(p: ProposalMeta): Promise<void> {
    // draft-map proposals carry no `files` payload (cluster/members instead),
    // so the generic count message would read "0 file(s)" — say what actually
    // happens: one LLM call drafts the map.
    const message =
      p.action === "draft-map"
        ? (t.pf_confirm_msg_draft_map ?? "Drafts the topic map (1 LLM call).")
        : (t.pf_confirm_msg ?? "{n} file(s) will be moved or archived.").replace(
            "{n}",
            String(p.files.length),
          );
    const ok = await confirmAction({
      title: t.pf_confirm_title ?? "Apply this proposal?",
      message,
    });
    if (!ok) return;
    const summary = await apply(p.path);
    setResult(summary ? { path: p.path, summary } : null);
  }

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_feedback ?? "Feedback"}</div>
        <h1 className="page-title">{t.pf_title ?? "Feedback"}</h1>
        <p className="page-lede">
          {t.pf_lede ??
            "Proposals the distillation engine wrote while folding new pages into the wiki — review and apply, or dismiss."}
        </p>
      </header>

      <div
        className="segmented"
        role="tablist"
        aria-label={t.nav_feedback ?? "Feedback"}
        style={{ marginTop: 8 }}
      >
        <button
          role="tab"
          aria-selected={tab === "proposals"}
          className={tab === "proposals" ? "active" : ""}
          onClick={() => setTab("proposals")}
        >
          {t.pf_tab_proposals ?? "Proposals"}
        </button>
        <button
          role="tab"
          aria-selected={tab === "quarantine"}
          className={tab === "quarantine" ? "active" : ""}
          onClick={() => setTab("quarantine")}
        >
          {(t.pf_tab_quarantine ?? "Quarantine {n}")
            .replace("{n}", quarantineCount > 0 ? String(quarantineCount) : "")
            .trim()}
        </button>
      </div>

      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12.5, marginTop: 12 }}>{error}</div>
      ) : null}

      {tab === "quarantine" ? (
        <QuarantineTab t={t} />
      ) : loading && proposals.length === 0 ? (
        <p className="muted" style={{ marginTop: 16 }}>
          {t.set_distill_loading ?? "Loading…"}
        </p>
      ) : proposals.length === 0 ? (
        <p className="muted" style={{ marginTop: 16 }}>
          {t.pf_empty ?? "No pending proposals."}
        </p>
      ) : (
        <div className="col" style={{ gap: 12, marginTop: 16 }}>
          {proposals.map((p) => {
            const isOpen = expanded === p.path;
            // Only reachable state for a still-listed `approved` proposal: a
            // prior applyDistillProposal call failed after the pending->approved
            // rewrite succeeded (refresh() only keeps pending/approved — a
            // successful apply flips it to `done` server-side and it drops out).
            const failedApply = p.status === "approved";
            return (
              <div key={p.path} className="card">
                <div
                  className="row"
                  style={{ justifyContent: "space-between", alignItems: "flex-start" }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.title}</div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {kindLabel(t, p.action)} · {t.pf_created ?? "Created"} {p.created}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost btn"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? (t.pf_collapse ?? "Collapse") : (t.pf_expand ?? "Expand")}
                    onClick={() => setExpanded(isOpen ? null : p.path)}
                  >
                    <Icon name={isOpen ? "chevD" : "chevR"} size={12} />
                  </button>
                </div>

                {isOpen ? (
                  <div style={{ marginTop: 10 }}>
                    <Viewer content={p.raw} />
                  </div>
                ) : null}

                {failedApply ? (
                  <div style={{ color: "#dc2626", fontSize: 12, marginTop: 10 }}>
                    {t.pf_apply_failed ?? "Apply failed — retry"}
                  </div>
                ) : null}

                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleApprove(p)}
                  >
                    {failedApply ? (t.pf_retry ?? "Retry") : (t.pf_approve ?? "Approve")}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn"
                    onClick={() => void dismiss(p.path)}
                  >
                    {t.pf_dismiss ?? "Dismiss"}
                  </button>
                </div>

                {result?.path === p.path ? (
                  <div style={{ color: "#16a34a", fontSize: 12, marginTop: 8 }}>
                    {result.summary}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
