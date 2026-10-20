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
import { getDeletionPolicy, useSettingsStore } from "../stores/settingsStore";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import {
  confirmQuarantineBatch,
  proposalNotice,
  proposalOutcome,
  useDistillStore,
  withQuarantineLock,
} from "../stores/distillStore";
import type { ProposalAction, ProposalMeta } from "../stores/distillStore";
import { confirmAction } from "../stores/dialogStore";
import {
  groupLabel,
  groupQuarantine,
  ttlLine,
  verdictSentence,
  KEEP_DAYS,
} from "../lib/quarantine";
import type { QuarantineItem } from "../lib/quarantine";
import AppPage from "../components/AppPage";
import { Segment } from "../components/ui";
import Viewer from "../components/Viewer";

function kindLabel(t: Strings, action: ProposalAction): string {
  if (action === "admit-cluster") return t.pf_kind_admit ?? "Admit cluster";
  if (action === "archive-batch") return t.pf_kind_archive ?? "Archive batch";
  if (action === "draft-map") return t.pf_kind_draft_map ?? "Draft topic map";
  return t.pf_kind_delete ?? "Delete batch";
}

function QuarantineTab({ t }: { t: Strings }): JSX.Element {
  const permanent = useSettingsStore((s) => s.settings?.permanent_delete === true);
  const items = useDistillStore((s) => s.quarantine);
  const restore = useDistillStore((s) => s.restoreQuarantine);
  const trash = useDistillStore((s) => s.trashQuarantine);
  const keep = useDistillStore((s) => s.keepQuarantine);
  const busy = useDistillStore((s) => s.quarantineBusy);

  async function handleDelete(item: QuarantineItem): Promise<void> {
    const policy = getDeletionPolicy();
    if (policy === null) { useDistillStore.setState({ error: t.delete_policy_wait }); return; }
    const ok = await confirmAction({
      title: t.qz_confirm_delete_title ?? "Delete this item?",
      danger: true,
      message: (policy ? t.delete_permanent_one_msg :
        t.qz_confirm_delete_msg ??
        "{name} goes to the system trash (recoverable from there)."
      ).replace("{name}", item.name),
    });
    if (!ok) return;
    await withQuarantineLock(item.path, () => trash([item.path], policy));
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
          "Items automatic organization set aside: sessions no person wrote, and items it judged off-topic. They are held, not deleted — restore what belongs, trash what doesn't."}
      </p>
      {groupQuarantine(items).map((group) => {
        const headingId = `qz-group-${group.key}`;
        // A batch would move a file a card action is already moving.
        const groupLocked =
          busy.has(group.key) || group.items.some((i) => busy.has(i.path));
        return (
          <section
            key={group.key}
            className="col"
            style={{ gap: 8, marginTop: 8 }}
            aria-labelledby={headingId}
            data-testid="quarantine-group"
          >
            <div
              className="row"
              style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <h2 id={headingId} className="section-title" style={{ fontSize: 14, margin: 0 }}>
                {groupLabel(group.key, t)}{" "}
                <span className="muted" style={{ fontWeight: 400 }}>
                  {group.items.length}
                </span>
              </h2>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn-ghost btn"
                  disabled={groupLocked}
                  onClick={() => void confirmQuarantineBatch("restore", group, t)}
                >
                  {t.qz_restore_all ?? "Restore all"}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn"
                  disabled={groupLocked}
                  onClick={() => void confirmQuarantineBatch("trash", group, t)}
                >
                  {permanent ? t.set_delete_permanent : t.qz_trash_all ?? "Trash all"}
                </button>
              </div>
            </div>
            {group.items.map((item) => {
              const locked = busy.has(item.path) || busy.has(group.key);
              return (
                <div key={item.path} className="card" data-testid="quarantine-item">
                  <div style={{ fontWeight: 600 }}>{item.name}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {/* A machine group's heading already says why; the
                        similarity sentence would only read "0.00" there. */}
                    {group.key === "other" ? `${verdictSentence(item, t)} · ` : null}
                    {ttlLine(item, t, Date.now(), permanent)}
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
                      disabled={locked}
                      onClick={() =>
                        void withQuarantineLock(item.path, () => restore([item.path]))
                      }
                    >
                      {t.qz_restore ?? "Restore to vault"}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn"
                      disabled={locked}
                      onClick={() =>
                        void withQuarantineLock(item.path, () => keep(item.path, KEEP_DAYS))
                      }
                    >
                      {(t.qz_keep ?? "Keep {n} more days").replace("{n}", String(KEEP_DAYS))}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn"
                      disabled={locked}
                      onClick={() => void handleDelete(item)}
                    >
                      {t.qz_delete ?? "Delete"}
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

export default function PageFeedback({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const tab = useUIStore((s) => s.feedbackTab);
  const permanent = useSettingsStore((s) => s.settings?.permanent_delete === true);
  const setTab = useUIStore((s) => s.setFeedbackTab);
  const proposals = useDistillStore((s) => s.proposals);
  const quarantineCount = useDistillStore((s) => s.quarantine.length);
  const loading = useDistillStore((s) => s.loading);
  const error = useDistillStore((s) => s.error);
  const needsWriter = useDistillStore((s) => s.needsWriter);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const setRoute = useUIStore((s) => s.setRoute);
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
    const policy = p.action === "delete-batch" ? getDeletionPolicy() : undefined;
    if (policy === null) { useDistillStore.setState({ error: t.delete_policy_wait }); return; }
    // The same sentence the card shows beside Approve.
    const ok = await confirmAction({
      title: t.pf_confirm_title ?? "Apply this proposal?",
      message: proposalOutcome(p, t, policy),
      danger: p.action === "delete-batch",
    });
    if (!ok) return;
    const summary = await apply(p.path, policy);
    setResult(summary ? { path: p.path, summary } : null);
  }

  return (
    <AppPage
      eyebrow={t.nav_workspace}
      title={t.pf_title ?? "Feedback"}
      note={
        t.pf_lede ??
        "Suggestions from automatic organization: take in new notes that have gathered into a topic, archive or delete sources you no longer need, or draft a topic map. Review each one, then approve or dismiss it."
      }
      bar={
        <Segment
          label={t.nav_feedback ?? "Feedback"}
          value={tab}
          onChange={setTab}
          options={[
            { value: "proposals", label: t.pf_tab_proposals ?? "Proposals" },
            {
              value: "quarantine",
              // The string carries the count inline ("Quarantine {n}"); the
              // kit has a slot for it, so it goes there instead.
              label: (t.pf_tab_quarantine ?? "Quarantine {n}")
                .replace("{n}", "")
                .trim(),
              count: quarantineCount > 0 ? quarantineCount : undefined,
            },
          ]}
        />
      }
    >
      {error ? (
        <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 12 }}>{error}</div>
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
            const notice = proposalNotice(p, needsWriter);
            const failedApply = notice === "failed";
            const bodyId = `pf-body-${p.path}`;
            const outcome = proposalOutcome(p, t, permanent);
            // The whole head opens the card, and the decision only shows once
            // it is open: you see what you approve before you can (UX S20).
            return (
              <div key={p.path} className="card pf-card">
                <button
                  type="button"
                  className="pf-card__head"
                  aria-expanded={isOpen}
                  aria-controls={bodyId}
                  onClick={() => setExpanded(isOpen ? null : p.path)}
                >
                  <span className="pf-card__name">
                    <strong>{p.title}</strong>
                    <span className="muted">
                      {kindLabel(t, p.action)} · {t.pf_created ?? "Created"} {p.created}
                    </span>
                  </span>
                  <span className="pf-card__toggle">
                    {isOpen ? (t.pf_collapse ?? "Hide details") : (t.pf_expand ?? "Show details")}
                    <Icon name={isOpen ? "chevD" : "chevR"} size={12} />
                  </span>
                </button>

                {failedApply ? (
                  <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>
                    {t.pf_apply_failed ?? "Apply failed — retry"}
                  </div>
                ) : null}

                <div id={bodyId} hidden={!isOpen}>
                  {isOpen ? (
                    <>
                      <div style={{ marginTop: 10 }}>
                        <Viewer content={p.raw} />
                      </div>

                      {/* No approve (or confirm) for a map nothing can write: the
                          way forward is a writing model, so that is the button. */}
                      {notice === "needs-writer" ? (
                        <div
                          className="row muted"
                          style={{ gap: 8, marginTop: 10, fontSize: 12, flexWrap: "wrap" }}
                        >
                          <span>
                            {t.pf_map_needs_writer ??
                              "Writing a topic map needs a model that can write"}
                          </span>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ fontSize: 12, padding: "2px 8px" }}
                            onClick={() => {
                              setSettingsTab("model");
                              setRoute("settings");
                            }}
                          >
                            {t.q_open_model_settings ?? "Model settings"} →
                          </button>
                        </div>
                      ) : null}

                      <div
                        className="row"
                        style={{ gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}
                      >
                        {notice === "retired" ? (
                          <span className="muted" style={{ fontSize: 12.5 }}>
                            {t.pf_retired ?? "No longer needed — the originals stay as they are"}
                          </span>
                        ) : notice === "needs-writer" ? null : (
                          <>
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => void handleApprove(p)}
                            >
                              {failedApply ? (t.pf_retry ?? "Retry") : (t.pf_approve ?? "Approve")}
                            </button>
                            <span className="muted" style={{ fontSize: 12.5 }}>
                              {outcome}
                            </span>
                          </>
                        )}
                        <button
                          type="button"
                          className="btn-ghost btn"
                          onClick={() => void dismiss(p.path)}
                        >
                          {t.pf_dismiss ?? "Dismiss"}
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>

                {result?.path === p.path ? (
                  <div style={{ color: "var(--ok)", fontSize: 12, marginTop: 8 }}>
                    {result.summary}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </AppPage>
  );
}
