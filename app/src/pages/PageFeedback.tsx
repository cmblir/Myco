// Feedback — the pending distill-proposal inbox (Task 9, Phase A). Surfaces
// what Task 6/7's idle run left in work/feedback/*.md: emerging clusters to
// admit, stale batches to archive or delete. Approve rewrites the proposal's
// frontmatter to `approved` then calls applyDistillProposal; dismiss rewrites
// it to `dismissed`. Both just delegate to distillStore — this page is purely
// presentational plus the confirm dialog on approve.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";
import { useDistillStore } from "../stores/distillStore";
import type { ProposalAction, ProposalMeta } from "../stores/distillStore";
import { confirmAction } from "../stores/dialogStore";
import Viewer from "../components/Viewer";

function kindLabel(t: Strings, action: ProposalAction): string {
  if (action === "admit-cluster") return t.pf_kind_admit ?? "Admit cluster";
  if (action === "archive-batch") return t.pf_kind_archive ?? "Archive batch";
  if (action === "draft-map") return t.pf_kind_draft_map ?? "Draft topic map";
  return t.pf_kind_delete ?? "Delete batch";
}

export default function PageFeedback({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const proposals = useDistillStore((s) => s.proposals);
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

      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12.5, marginTop: 12 }}>{error}</div>
      ) : null}

      {loading && proposals.length === 0 ? (
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
