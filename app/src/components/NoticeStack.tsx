// Toast stack for the main window — results only; progress is the activity
// chip's job (see stores/noticeStore.ts). Fixed under the Topbar's right
// edge so a toast drops in directly beneath the chip. The stack itself is a
// permanently-mounted live region: assistive tech only announces additions
// to a region that already existed, so the wrapper is never conditional.

import { useEffect, useRef, useState } from "react";
import type { FocusEvent, JSX, KeyboardEvent } from "react";
import { ActivityIcon } from "./ActivityPanel";
import { IconButton } from "./ui";
import { Icon } from "../lib/icons";
import { STRINGS } from "../lib/i18n";
import { useNoticeStore } from "../stores/noticeStore";
import type { Notice } from "../stores/noticeStore";
import { useUIStore } from "../stores/uiStore";

/** Matches `notice-out` in styles.css — the store entry is removed once the
 * slide-right has played. */
const EXIT_MS = 240;

/**
 * Whose × takes focus when `closing` goes while focus is inside it: the next
 * older toast (it slides into the closed one's place), else the newer one,
 * skipping toasts already on their way out. null when none is left.
 * `order` is display order, newest first.
 */
export function focusAfterClose(
  order: readonly string[],
  leaving: ReadonlySet<string>,
  closing: string,
): string | null {
  const i = order.indexOf(closing);
  const live = (id: string | undefined): id is string =>
    id !== undefined && id !== closing && !leaving.has(id);
  for (let j = i + 1; j < order.length; j++) if (live(order[j])) return order[j];
  for (let j = i - 1; j >= 0; j--) if (live(order[j])) return order[j];
  return null;
}

export default function NoticeStack(): JSX.Element {
  const notices = useNoticeStore((s) => s.notices);
  const dismiss = useNoticeStore((s) => s.dismiss);
  const lang = useUIStore((s) => s.lang);
  const closeLabel = (STRINGS[lang] ?? STRINGS.en).ui_close;
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const stackRef = useRef<HTMLDivElement | null>(null);
  /** What had focus before the user tabbed into the stack. */
  const returnTo = useRef<HTMLElement | null>(null);

  // A keyboard close (the ×, the action, Escape) removes the focused button:
  // hand focus to the neighbouring toast, or back to where it came from once
  // the stack empties, instead of letting it fall to <body>.
  const close = (id: string): void => {
    const stack = stackRef.current;
    const closing = stack?.querySelector(`[data-notice-id="${id}"]`);
    if (stack && closing?.contains(document.activeElement)) {
      const order = [...notices].reverse().map((n) => n.id);
      const next = focusAfterClose(order, leaving, id);
      const target = next
        ? stack.querySelector<HTMLElement>(`[data-notice-id="${next}"] .notice-close`)
        : returnTo.current?.isConnected
          ? returnTo.current
          : null;
      target?.focus();
    }
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

  // Each entry from outside the stack records where focus came from (null
  // from <body>), so an old opener is never handed focus later.
  const onFocus = (e: FocusEvent<HTMLDivElement>): void => {
    const from = e.relatedTarget;
    if (from instanceof Node && e.currentTarget.contains(from)) return;
    returnTo.current = from instanceof HTMLElement ? from : null;
  };

  return (
    <div
      ref={stackRef}
      className="notice-stack"
      role="status"
      aria-live="polite"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {[...notices].reverse().map((n, depth) => (
        <Toast
          key={n.id}
          notice={n}
          depth={depth}
          leaving={leaving.has(n.id)}
          closeLabel={closeLabel}
          onClose={() => close(n.id)}
        />
      ))}
    </div>
  );
}

/** Exported for the render test: SSR reads a store's initial state, so the
 * test hands a toast its props directly. */
export function Toast({
  notice,
  depth,
  leaving,
  closeLabel,
  onClose,
}: {
  notice: Notice;
  depth: number;
  leaving: boolean;
  closeLabel: string;
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
      data-notice-id={notice.id}
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
      ) : null}
      {/* No focus on press: a pointer close leaves focus in the editor or
          field the user was typing in. */}
      <IconButton
        className="notice-close"
        aria-label={closeLabel}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
      >
        <Icon name="x" size={14} />
      </IconButton>
      <i className="notice-life" style={{ animationDuration: `${notice.ttlMs}ms` }} />
    </div>
  );
}
