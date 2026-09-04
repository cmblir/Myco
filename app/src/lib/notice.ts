// The one-line call site for a toast: `notice.ok(title, { sub, icon, action })`.
// Kind decides the default life — warnings stay longer because the user has
// to read an error string, not just register a green tick.

import { useNoticeStore } from "../stores/noticeStore";
import type { Notice, NoticeKind } from "../stores/noticeStore";

export type NoticeOpts = Partial<Pick<Notice, "sub" | "icon" | "action" | "ttlMs">>;

export const NOTICE_TTL_MS: Record<NoticeKind, number> = {
  ok: 4000,
  info: 4000,
  warn: 6000,
};

function push(kind: NoticeKind, title: string, opts: NoticeOpts = {}): string {
  return useNoticeStore
    .getState()
    .push({ kind, title, ttlMs: NOTICE_TTL_MS[kind], ...opts });
}

export const notice = {
  ok: (title: string, opts?: NoticeOpts): string => push("ok", title, opts),
  info: (title: string, opts?: NoticeOpts): string => push("info", title, opts),
  warn: (title: string, opts?: NoticeOpts): string => push("warn", title, opts),
};
