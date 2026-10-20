// RecallPicker — `/recall` (`/기록`) at the caret: search past records the
// way Ask does (similarity judged against the floor, a time phrase such as
// "지난주" as a date window, a scope chip) and insert a hit as a verbatim
// quote with its source, or as an embed. Nothing below the floor is
// insertable; the closest misses are only shown. In `ask` mode (`/ask`,
// `/질문`) Enter asks the question and shows the answer — one callout of
// the vault's own words (lib/editorRecall.ts askSearch) — and Enter again
// inserts it; an abstention inserts nothing. OnThisDayPicker —
// `/onthisday` (`/오늘의 과거`): past years' daily notes of today's
// month-day, inserted as links. The edits are lib/editorRecall.ts, one undo
// step each. Styling and keys follow the block menu (BlockMenu.tsx).

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FocusEvent,
  JSX,
  KeyboardEvent,
  MouseEvent,
  RefObject,
} from "react";
import type { EditorView } from "@codemirror/view";
import type { Strings } from "../lib/i18n";
import type { AskScope } from "../lib/ipc";
import type { SlashPicker } from "../lib/editorCompletions";
import { flattenMarkdown, stem } from "../lib/graphData";
import {
  askSearch,
  insertBlockTr,
  linkList,
  onThisDay,
  quoteBlock,
  recallSearch,
  type AskView,
  type RecallRow,
  type RecallView,
} from "../lib/editorRecall";
import { confidenceBand } from "../lib/extractive";
import { popoverPlace } from "../lib/popoverPlace";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useActiveRowInView } from "./BlockMenu";

export interface RecallRequest {
  view: EditorView;
  mode: SlashPicker;
  /** Where the insert goes; the editor maps it through later edits. */
  pos: number;
  /** Viewport point the picker's top-left corner goes to (under the caret's
   *  line)… */
  x: number;
  y: number;
  /** …or, near the window's bottom, the y its bottom edge goes to (above
   *  the line), so it never covers the line it inserts at. */
  above: number;
  /** Ask mode: a question to open on and ask at once ("Ask about this
   *  block"). */
  question?: string;
}

interface PickerProps {
  t: Strings;
  req: RecallRequest;
  /** `refocus`: hand focus back to the editor (Esc, a pick), not on blur. */
  onClose: (refocus: boolean) => void;
}

/** Place the popover by the caret's line and keep it inside the window as
 *  results arrive (popoverPlace), focus the `focus` element in it, and close
 *  it once focus leaves it. The handlers go on the popover's box. */
function usePopover(
  boxRef: RefObject<HTMLDivElement>,
  { x, y, above }: RecallRequest,
  focus: string,
  onClose: (refocus: boolean) => void,
): {
  onBlur: (e: FocusEvent<HTMLDivElement>) => void;
  onMouseDown: (e: MouseEvent<HTMLDivElement>) => void;
} {
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.maxHeight = ""; // read the stylesheet's cap, not our last one
    const p = popoverPlace({
      x,
      above,
      below: y,
      width: el.offsetWidth,
      cap: parseFloat(getComputedStyle(el).maxHeight) || window.innerHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
    });
    el.style.left = `${p.left}px`;
    el.style.top = p.top === null ? "" : `${p.top}px`;
    el.style.bottom = p.bottom === null ? "" : `${p.bottom}px`;
    el.style.maxHeight = `${p.maxHeight}px`;
    el.querySelector<HTMLElement>(focus)?.focus();
  }, [boxRef, focus, x, y, above]);
  return {
    onBlur: (e) => {
      if (!boxRef.current?.contains(e.relatedTarget as Node | null))
        onClose(false);
    },
    // A press anywhere else in the box (the answer preview, a row, a chip)
    // must not take focus from `focus`: the blur would close the popover
    // and leave focus on <body>.
    onMouseDown: (e) => {
      if (!(e.target as Element).closest(focus)) e.preventDefault();
    },
  };
}

/** Arrow keys over `n` rows (wrapping), Enter, Esc; none mid-composition
 *  (Korean IME). */
function listKeys(
  e: KeyboardEvent,
  n: number,
  move: (step: 1 | -1) => void,
  enter: () => void,
  close: () => void,
): void {
  if (e.nativeEvent.isComposing) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (n > 0) move(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    enter();
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

const SCOPES: readonly AskScope[] = ["all", "wiki", "sessions"];
/** Typing pauses this long before a search (each costs a query embedding). */
const DEBOUNCE_MS = 200;

export default function RecallPicker({
  t,
  req,
  onClose,
}: PickerProps): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const previewId = `${listId}-preview`;
  const ask = req.mode === "ask";
  const [query, setQuery] = useState(req.question ?? "");
  // Ask: the question Enter asked; Enter on the same text inserts the answer.
  const [asked, setAsked] = useState(req.question ?? "");
  // Counts every other Enter, so the same question after a failure (or a
  // stale index) asks again instead of leaving the state unchanged.
  const [tries, setTries] = useState(0);
  const [scope, setScope] = useState<AskScope>("all");
  const [found, setFound] = useState<RecallView | AskView | "loading" | null>(
    null,
  );
  const [active, setActive] = useState(0);
  const rows: RecallRow[] =
    found && found !== "loading" && found.kind === "hits" ? found.rows : [];
  const current = rows[Math.min(active, rows.length - 1)];
  const activeId = current ? `${listId}-${rows.indexOf(current)}` : undefined;
  useActiveRowInView(activeId);

  const popover = usePopover(boxRef, req, "input", onClose);

  // Recall searches as the query is typed; ask searches the question Enter
  // asked (again when the scope changes).
  const text = ask ? asked : query;
  useEffect(() => {
    if (!text.trim()) {
      setFound(null);
      return;
    }
    setFound("loading");
    let alive = true;
    const id = setTimeout(
      () => {
        const run: Promise<RecallView | AskView> = ask
          ? askSearch(text, scope, new Date(), lang)
          : recallSearch(text, scope, new Date(), lang);
        void run.then(
          (v) => {
            if (!alive) return;
            setFound(v);
            setActive(0);
          },
          () => alive && setFound({ kind: "failed" }),
        );
      },
      ask ? 0 : DEBOUNCE_MS,
    );
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [ask, text, scope, lang, tries]);
  const done = found === "loading" ? null : found;

  function insertBlock(block: string): void {
    // Change first, then focus: the editor draws the new selection on focus.
    req.view.dispatch(insertBlockTr(req.view.state, req.pos, block));
    onClose(true);
  }

  function insert(row: RecallRow | undefined, embed: boolean): void {
    if (row)
      insertBlock(
        embed ? `![[${row.target}]]` : quoteBlock(row.excerpt, row.target),
      );
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Focus stays in the field, so Esc, the arrows and Enter always work:
    // Tab / Shift-Tab step through the scope chips instead of focusing them.
    if (e.key === "Tab" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const step = e.shiftKey ? SCOPES.length - 1 : 1;
      setScope((s) => SCOPES[(SCOPES.indexOf(s) + step) % SCOPES.length]);
      return;
    }
    // Ask has no rows to step through: the keys scroll the answer that
    // Enter inserts, so all of it can be read first.
    if (
      ask &&
      !e.nativeEvent.isComposing &&
      /^(Arrow|Page)(Up|Down)$/.test(e.key)
    ) {
      e.preventDefault();
      const list = boxRef.current?.querySelector(".block-menu__list");
      if (!list) return;
      const step = e.key.startsWith("Page") ? list.clientHeight - 24 : 40;
      list.scrollBy({ top: e.key.endsWith("Up") ? -step : step });
      return;
    }
    listKeys(
      e,
      rows.length,
      (step) => setActive((a) => (a + step + rows.length) % rows.length),
      () => {
        if (!ask) return insert(current, e.metaKey || e.ctrlKey);
        const q = query.trim();
        if (done?.kind === "answer" && q === asked) insertBlock(done.block);
        else {
          setAsked(q);
          setTries((n) => n + 1);
        }
      },
      () => onClose(true),
    );
  };

  const pct = (s: number | null | undefined): string =>
    s == null ? t.q_cite_sim_none : `${Math.round(s * 100)}%`;
  const scopeName: Record<AskScope, string> = {
    all: t.q_scope_all,
    wiki: t.q_scope_wiki,
    sessions: t.q_scope_sessions,
  };
  const range = done && "range" in done ? done.range : null;
  const message = {
    idle: ask ? t.rc_ask_hint : t.rc_hint,
    loading: t.rd_claim_searching,
    stale: t.rc_stale,
    failed: t.rc_failed,
    "no-index": t.rc_no_index,
    hits: "",
    answer:
      done?.kind === "answer"
        ? `${t[`q_cite_conf_${confidenceBand(done.best)}`]} · ${t.rc_ask_ready}`
        : "",
    none: done?.kind === "none" ? t.rc_none : "",
  }[found === null ? "idle" : found === "loading" ? "loading" : found.kind];
  return (
    <div
      ref={boxRef}
      className="block-menu recall-pop"
      role="dialog"
      aria-label={ask ? t.rc_ask_title : t.rc_title}
      {...popover}
    >
      <input
        className="block-menu__search"
        value={query}
        placeholder={ask ? t.rc_ask : t.rc_search}
        // Ask shows one answer, no options to pick from: a plain field
        // that the preview describes.
        role={ask ? undefined : "combobox"}
        aria-expanded={ask ? undefined : true}
        aria-controls={ask ? undefined : listId}
        aria-autocomplete={ask ? undefined : "list"}
        aria-activedescendant={activeId}
        aria-describedby={done?.kind === "answer" ? previewId : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="recall-pop__scopes" role="group" aria-label={t.q_scope_label}>
        {SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            className="recall-pop__chip"
            aria-pressed={scope === s}
            // Keep focus (and typing) in the search field; Tab steps the
            // scope from there.
            tabIndex={-1}
            onClick={() => setScope(s)}
          >
            {scopeName[s]}
          </button>
        ))}
      </div>
      {range ? (
        <p className="recall-pop__range">
          {t.rc_range.replace("{start}", range.start).replace("{end}", range.end)}
        </p>
      ) : null}
      {ask ? (
        // One polite live region, there from the start: loading → the
        // answer's band, or why nothing is inserted, is announced. The long
        // preview stays out of it.
        <p
          className={
            done?.kind === "answer" ? "block-menu__head" : "block-menu__empty"
          }
          role="status"
        >
          {message}
        </p>
      ) : null}
      <ul
        className="block-menu__list"
        role={ask ? undefined : "listbox"}
        id={listId}
      >
        {message && !ask ? (
          <li className="block-menu__empty" role="presentation">
            {message}
          </li>
        ) : null}
        {done?.kind === "none" && done.near.length ? (
          <li className="block-menu__head" role="presentation">
            {t.q_abstain_near}
          </li>
        ) : null}
        {done?.kind === "none"
          ? done.near.map((m) => (
              <li key={m.page} className="recall-pop__near" role="presentation">
                <span className="recall-pop__title" title={m.page}>
                  {stem(m.page)}
                </span>
                <span className="rail-n">{pct(m.similarity)}</span>
              </li>
            ))
          : null}
        {done?.kind === "answer" ? (
          <li role="presentation">
            <pre id={previewId} className="recall-pop__preview">
              {done.block}
            </pre>
          </li>
        ) : null}
        {rows.map((row, i) => (
          <li
            key={`${row.hit.page}#${row.hit.section}`}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={row === current}
            className={
              "block-menu__item recall-pop__row" +
              (row === current ? " is-active" : "")
            }
            onPointerMove={() => setActive(i)}
            onClick={() => insert(row, false)}
          >
            <span className="recall-pop__main">
              <span className="recall-pop__title" title={row.hit.page}>
                {row.target}
              </span>
              <span className="recall-pop__excerpt">{row.excerpt}</span>
            </span>
            <span className="rail-n">{pct(row.hit.similarity)}</span>
            <button
              type="button"
              className="recall-pop__embed"
              tabIndex={-1}
              title={t.rc_embed}
              aria-label={t.rc_embed}
              onClick={(e) => {
                e.stopPropagation();
                insert(row, true);
              }}
            >
              ![[ ]]
            </button>
          </li>
        ))}
      </ul>
      <p className="recall-pop__foot" aria-hidden="true">
        {ask ? t.rc_ask_keys : t.rc_keys}
      </p>
    </div>
  );
}

/** `/onthisday`: the first row inserts every past entry, each row below one. */
export function OnThisDayPicker({
  t,
  req,
  onClose,
}: PickerProps): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const tree = useVaultStore((s) => s.fileTree);
  const root = useVaultStore((s) => s.currentVault?.path ?? "");
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [now] = useState(() => new Date());
  const days = useMemo(
    () => onThisDay(flattenMarkdown(tree), root, now),
    [tree, root, now],
  );
  const options = days.length > 1 ? [days, ...days.map((d) => [d])] : days.map((d) => [d]);
  const [active, setActive] = useState(0);
  useActiveRowInView(options.length ? `${listId}-${active}` : undefined);
  const popover = usePopover(boxRef, req, "ul", onClose);
  const date = new Intl.DateTimeFormat(lang, { month: "long", day: "numeric" }).format(now);
  const ago = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });

  function insert(stems: string[] | undefined): void {
    if (!stems) return;
    req.view.dispatch(insertBlockTr(req.view.state, req.pos, linkList(stems)));
    onClose(true);
  }

  return (
    <div
      ref={boxRef}
      className="block-menu recall-pop"
      role="dialog"
      aria-label={t.otd_title.replace("{date}", date)}
      {...popover}
    >
      <p className="block-menu__head">{t.otd_title.replace("{date}", date)}</p>
      <ul
        className="block-menu__list"
        role="listbox"
        id={listId}
        tabIndex={0}
        aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
        onKeyDown={(e) =>
          listKeys(
            e,
            options.length,
            (step) => setActive((a) => (a + step + options.length) % options.length),
            () => insert(options[active]),
            () => onClose(true),
          )
        }
      >
        {options.length === 0 ? (
          <li className="block-menu__empty" role="presentation">
            {t.otd_none.replace("{date}", date)}
          </li>
        ) : null}
        {options.map((stems, i) => (
          <li
            key={stems.join()}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={"block-menu__item" + (i === active ? " is-active" : "")}
            onPointerMove={() => setActive(i)}
            onClick={() => insert(stems)}
          >
            {stems.length > 1 ? (
              t.otd_all.replace("{n}", String(stems.length))
            ) : (
              <>
                <span className="recall-pop__title">{stems[0]}</span>
                <span className="rail-n">
                  {ago.format(Number(stems[0].slice(0, 4)) - now.getFullYear(), "year")}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="recall-pop__foot" aria-hidden="true">
        {t.otd_keys}
      </p>
    </div>
  );
}
