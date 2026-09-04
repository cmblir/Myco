// Toast stack for the main window — results only; progress is the activity
// chip's job (see stores/noticeStore.ts). Fixed under the Topbar's right
// edge so a toast drops in directly beneath the chip. The stack itself is a
// permanently-mounted live region: assistive tech only announces additions
// to a region that already existed, so the wrapper is never conditional.

import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { ActivityIcon } from "./ActivityPanel";
import { useNoticeStore } from "../stores/noticeStore";
import type { Notice } from "../stores/noticeStore";

/** Matches `notice-out` in styles.css — the store entry is removed once the
 * slide-right has played. */
const EXIT_MS = 240;

export default function NoticeStack(): JSX.Element {
  const notices = useNoticeStore((s) => s.notices);
  const dismiss = useNoticeStore((s) => s.dismiss);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());

  const close = (id: string): void => {
    setLeaving((s) => new Set(s).add(id));
    window.setTimeout(() => {
      dismiss(id);
      setLeaving((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }, EXIT_MS);
  };

  // A keydown only reaches the stack from inside it (the action button), so
  // Escape here always means "focus is in the stack": drop the newest toast.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Escape") return;
    const newest = [...notices].reverse().find((n) => !leaving.has(n.id));
    if (!newest) return;
    e.stopPropagation();
    close(newest.id);
  };

  return (
    <div
      className="notice-stack"
      role="status"
      aria-live="polite"
      onKeyDown={onKeyDown}
    >
      {[...notices].reverse().map((n, depth) => (
        <Toast
          key={n.id}
          notice={n}
          depth={depth}
          leaving={leaving.has(n.id)}
          onClose={() => close(n.id)}
        />
      ))}
    </div>
  );
}

function Toast({
  notice,
  depth,
  leaving,
  onClose,
}: {
  notice: Notice;
  depth: number;
  leaving: boolean;
  onClose: () => void;
}): JSX.Element {
  const [held, setHeld] = useState(false);
  const remaining = useRef(notice.ttlMs);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The life timer really pauses while hovered/focused (the CSS bar pauses
  // via animation-play-state; this keeps the JS clock in step with it).
  useEffect(() => {
    if (held || leaving) return;
    const started = Date.now();
    const id = window.setTimeout(() => onCloseRef.current(), remaining.current);
    return () => {
      window.clearTimeout(id);
      remaining.current -= Date.now() - started;
    };
  }, [held, leaving]);

  const cls = [
    "notice",
    `is-${notice.kind}`,
    depth > 0 ? `is-depth-${Math.min(depth, 2)}` : "",
    leaving ? "is-out" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="notice-icon" aria-hidden="true">
        {notice.icon ? (
          <ActivityIcon name={notice.icon} size={22} />
        ) : (
          <span className="notice-dot" />
        )}
        {notice.kind === "ok" ? (
          <svg className="notice-check" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6.5l2.5 2.5 4.5-5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      <span className="notice-body">
        <span className="notice-title">{notice.title}</span>
        {notice.sub ? <span className="notice-sub">{notice.sub}</span> : null}
      </span>
      {notice.action ? (
        <button
          type="button"
          className="notice-action"
          onClick={() => {
            notice.action?.run();
            onClose();
          }}
        >
          {notice.action.label}
        </button>
      ) : (
        <span />
      )}
      <i className="notice-life" style={{ animationDuration: `${notice.ttlMs}ms` }} />
    </div>
  );
}
