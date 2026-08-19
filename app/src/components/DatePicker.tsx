// DatePicker — a themed stand-in for `<input type="date">`, whose macOS
// WebKit popover is a white system panel that ignores the app theme. The
// trigger is a real button showing the picked date in the app's language; the
// popover is a month grid portalled to <body> and placed with the same
// viewport-clamped math as the Topbar model popover (computeModelPopPos).
//
// The value contract is exactly the native input's: a local `YYYY-MM-DD`
// string, or "" for no date. Dates are built from local components only
// (taskLine's today/parseIsoDate) — never Date.parse — so there is no
// timezone drift between what is picked and what is written.

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { monthGrid, parseIsoDate, today } from "../lib/taskLine";
import { useUIStore } from "../stores/uiStore";
import { computeModelPopPos } from "./Topbar";

/** The locale's first weekday in getDay() terms (0 = Sunday … 6 = Saturday).
 * Intl's weekInfo is a live proposal shipped under two shapes (a getWeekInfo()
 * method in WebKit, a weekInfo getter in V8); Monday when neither exists. */
function localeWeekStart(lang: string): number {
  try {
    const loc = new Intl.Locale(lang) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay;
    // Intl counts 1 = Monday … 7 = Sunday; getDay() counts Sunday as 0.
    if (typeof first === "number") return first % 7;
  } catch {
    // Unknown language tag: fall through to Monday.
  }
  return 1;
}

export default function DatePicker({
  t,
  value,
  onChange,
  disabled,
}: {
  t: Strings;
  value: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
}): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const [open, setOpen] = useState(false);
  const [popPos, setPopPos] = useState<ReturnType<typeof computeModelPopPos> | null>(
    null,
  );
  // First of the month on display, and the day keyboard focus sits on.
  const [month, setMonth] = useState(() => new Date());
  const [focused, setFocused] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const label = t.tasks_due ?? "Due date";

  const openPopover = (): void => {
    const base = parseIsoDate(value) ?? new Date();
    setMonth(new Date(base.getFullYear(), base.getMonth(), 1));
    setFocused(today(base));
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPopPos(computeModelPopPos(r));
    setOpen(true);
  };

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const pick = (iso: string): void => {
    onChange(iso);
    close(true);
  };

  // Outside-click / Escape / resize handling — same shape as ModelChip's
  // (the popover portals to <body>, so both refs must be checked).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onResize = (): void => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPopPos(computeModelPopPos(r));
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Roving focus: exactly one day is tabbable, and moving with the arrows
  // keeps real DOM focus on it so Enter "clicks" the day natively.
  useEffect(() => {
    if (!open || !focused) return;
    popRef.current
      ?.querySelector<HTMLButtonElement>(`[data-iso="${focused}"]`)
      ?.focus();
  }, [open, focused]);

  /** Move keyboard focus by `delta` days, paging the view along with it. */
  const move = (delta: number): void => {
    const d = parseIsoDate(focused);
    if (!d) return;
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
    setFocused(today(next));
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) {
      setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
    }
  };

  const onGridKey = (e: React.KeyboardEvent): void => {
    const delta =
      e.key === "ArrowLeft" ? -1
      : e.key === "ArrowRight" ? 1
      : e.key === "ArrowUp" ? -7
      : e.key === "ArrowDown" ? 7
      : 0;
    if (delta) {
      e.preventDefault();
      move(delta);
    }
  };

  const weekStart = localeWeekStart(lang);
  const days = monthGrid(month, weekStart);
  const todayIso = today();
  const monthFmt = new Intl.DateTimeFormat(lang, { year: "numeric", month: "long" });
  const weekdayFmt = new Intl.DateTimeFormat(lang, { weekday: "short" });
  const dayFmt = new Intl.DateTimeFormat(lang, { dateStyle: "full" });
  const valueFmt = new Intl.DateTimeFormat(lang, { dateStyle: "medium" });
  const picked = parseIsoDate(value);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="input dp-trigger"
        onClick={() => (open ? close(false) : openPopover())}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        data-testid="date-picker"
      >
        {picked ? valueFmt.format(picked) : <span className="dp-ph">{label}</span>}
      </button>
      {open && popPos
        ? createPortal(
            <div
              className="model-chip-pop dp-pop"
              ref={popRef}
              role="dialog"
              aria-label={label}
              style={{
                top: popPos.top,
                left: popPos.left,
                width: popPos.width,
                maxHeight: popPos.maxHeight,
              }}
            >
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong style={{ fontSize: 13 }}>{monthFmt.format(month)}</strong>
                <span className="row" style={{ gap: 2 }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() =>
                      setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
                    }
                    aria-label={t.dp_prev ?? "Previous month"}
                  >
                    <Icon name="chevL" size={12} />
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() =>
                      setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
                    }
                    aria-label={t.dp_next ?? "Next month"}
                  >
                    <Icon name="chevR" size={12} />
                  </button>
                </span>
              </div>

              <div>
                <div className="dp-grid" aria-hidden="true">
                  {days.slice(0, 7).map((d) => (
                    <span key={`wd-${d.getDay()}`} className="dp-wd">
                      {weekdayFmt.format(d)}
                    </span>
                  ))}
                </div>
                <div className="dp-grid" onKeyDown={onGridKey}>
                  {days.map((d) => {
                    const iso = today(d);
                    return (
                      <button
                        key={iso}
                        type="button"
                        data-iso={iso}
                        tabIndex={iso === focused ? 0 : -1}
                        className={
                          "dp-day" +
                          (d.getMonth() !== month.getMonth() ? " is-outside" : "") +
                          (iso === todayIso ? " is-today" : "") +
                          (iso === value ? " is-selected" : "")
                        }
                        aria-label={dayFmt.format(d)}
                        aria-pressed={iso === value}
                        onClick={() => pick(iso)}
                      >
                        {d.getDate()}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="dp-foot">
                <button className="btn btn-ghost" onClick={() => pick(todayIso)}>
                  {t.tasks_cal_today ?? "Today"}
                </button>
                {/* A task may simply have no due date — "" is a first-class value. */}
                <button className="btn btn-ghost" onClick={() => pick("")} disabled={!value}>
                  {t.dp_clear ?? "Clear date"}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
