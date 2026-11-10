# Notion-style blocks and one editor

Owner, 2026-10-01, on three screenshots of the installed build:

- A `/table` table showing its markdown (`| Column | Column |`, `| --- | --- |`) once the caret
  is in it: "표가 이렇게 나오는데? 나는 노션 표처럼 나오게 해달라고 했잖아."
- A chart block showing its fence (```` ```chart ````, `type: bar`, `id: chart-data`) after a
  click, with a stray `^chart-data` line under its data table: "차트나 너가 방금 추가한 것들이 이렇게
  누르면 이상하게 나와. 이건 일반 사용자가 쓰기 어려워."
- The Reader's 쓰기 / 읽기 toggle: "쓰기, 읽기가 아니라 기본적으로 평범한 일반 사용자가 쓰기에 좋게끔
  해주고, md로 저장만 하게끔 해줘."

The user is someone who has never seen markdown. Files stay plain markdown on disk, readable by
Obsidian and GitHub. Markdown is the storage format, not the interface.

## Decisions

These replace earlier decisions where they conflict. Tests that pin the old behaviour are updated
to this contract, never deleted to make a run pass.

1. **One editor.** A note opens in one editing surface, the Live editor. The 쓰기 / 읽기 segmented
   toggle goes away. A `raw/` file still opens read-only through the Viewer, as today. The
   markdown source view stays available only from the ⋯ menu ("마크다운 원문 편집"), with its
   existing notice and way back. A stored `editorMode: "preview"` from an older build is read as
   `"live"`.
2. **Blocks never reveal their markdown in Live.** This covers every registry block (`BLOCKS` in
   `lib/blocks/index.ts`: TOC, image, embed, table, query, chart, mermaid, math) and every plugin
   fence. Today a caret or selection edge on a block's source shows the source
   (`lib/blocks/live.ts`, "Either end of a selection on a block's source shows the source"). That
   rule is removed. The only way to see a block's markdown is the source view in decision 1.
3. **A block is selected as a whole, like Notion.**
   - A click on a block that has no in-place editor selects it, and so does ArrowUp or ArrowDown
     onto it from the text around it. A selected block shows a visible ring (focus-visible
     style, tokens only).
   - Enter on a selected block opens its editor (table: first cell; fence: its panel).
   - Backspace or Delete on a selected block removes the block's lines in one undo step.
   - ⌘C and ⌘X copy the block's markdown. Escape clears the selection and puts the caret after
     the block.
   - ArrowUp and ArrowDown move on to the text before or after the block.
4. **Tables are Notion simple tables.** See "Table" below.
5. **Fenced blocks are edited in a panel, not as text.** See "Fenced blocks" below.
6. **Block tags are metadata.** A paragraph that is only a block tag (`^chart-data`) directly under
   a table renders as nothing in Live and in the Viewer. The chart that reads the table manages
   the tag.
7. **Every write is plain markdown.** A widget edit is one CodeMirror transaction that replaces
   the block's own lines with markdown, keeping a quote's or list item's leading marks. Text
   outside the block is never touched. An untouched block round-trips byte for byte.

## Invariants

- Korean IME: a widget never rebuilds the DOM around a field the user is composing in. A
  widget's own edit must not recreate the widget. Use `eq`/`updateDOM`, or keep the field
  element and update its siblings. A write waits for `compositionend`. The same rule applies to
  plugin inserts today.
- Undo: one editing session in a cell or a panel is one undo step. That session ends on blur,
  on leaving the cell or panel, or on 1 s idle. ⌘Z from inside a widget undoes the note's history,
  and the widget redraws from the restored text.
- raw/ is read-only: no widget editor opens there.
- Vault text reaches the DOM through `textContent` or the existing escaped renderers only.
- Every new string has en/ko/ja keys. Korean labels follow the glossary lint
  (`lib/i18n.glossary.test.ts`).
- Keyboard: everything a pointer can do in a table or panel can be done by keyboard. Every
  control is a `<button>` with an accessible name, and has a hit area of at least 28px inside
  the editor.

## Table

What the user sees:
- A grid with cell borders and a header row in the bold weight, at every caret position. The
  columns size to their content, with a minimum of about 120px. A table wider than the text
  column scrolls sideways inside its own box. Cells never squash, and Korean words are not
  broken mid-word: use `word-break: keep-all` and `overflow-wrap: break-word`.
- `/table` (표) inserts a 3-column × 3-row table, the header included, with empty cells. The
  caret lands in the first header cell. Empty header cells show a muted placeholder (열 1, 열 2,
  …) drawn by CSS, never written to the file.

Editing:
- A click in a cell puts a text caret there. The cell is a plain-text editable field. Inline
  markdown typed into a cell (`**굵게**`, `[[링크]]`) is kept as typed. When the cell loses
  focus, it draws through the existing inline renderer.
- Keys:
  - Tab and Shift+Tab move to the next and previous cell. Tab in the last cell adds a row.
  - Enter moves to the cell below. Enter in the last row adds a row.
  - ArrowUp, ArrowDown, ArrowLeft and ArrowRight move between cells when the caret is at the
    cell text's edge.
  - ArrowUp in the first row and ArrowDown in the last row leave the table to the text
    above or below.
  - Escape leaves the cell and selects the table (decision 3).
  - Backspace in an empty cell of an all-empty row removes that row.
- Hover and focus controls:
  - A "+" bar along the right edge adds a column, and one along the bottom edge adds a row.
  - A handle on each row and each column opens a menu with: 위에 행 추가, 아래에 행 추가,
    왼쪽에 열 추가, 오른쪽에 열 추가, 행 삭제, 열 삭제, and 정렬 (왼쪽 / 가운데 / 오른쪽), which
    writes `:---`, `:---:` and `---:`.
  - The last row or column cannot be deleted. Deleting the whole table is done by
    selecting the block.

Markdown written:
- GFM pipe table, `| a | b |` with single spaces.
- A `|` typed in a cell is written `\|`. A newline cannot be typed in a cell: Enter
  navigates. Pasted newlines become spaces.
- The delimiter row keeps each column's alignment.

Parity: the Viewer draws the same table, the same look, the same squash rules.

## Fenced blocks

Applies to chart, mermaid, math (`$$`), query (`myco-query`) and plugin fences.

- The block always shows its result: the chart, the diagram, the formula, the query's
  results, or the plugin's output. Bad input shows the existing friendly message inside the
  box, never the fence.
- Pointer hover and keyboard selection show a small toolbar at the block's top-right with
  편집 and 삭제. Click on the block, 편집, or Enter on a selected block opens its panel.
- The panel opens inline under the block, pushes the text below down, is not a modal, and
  is focus-trapped only while open. It has 완료 (or ⌘Enter), and Escape closes it and keeps the
  changes made so far. The result above updates live as the user types, with a debounce of
  about 300 ms. The panel never shows the ```` ``` ```` lines.
- Panels:
  - **Math:** one TeX field with live preview, like Notion's equation block.
  - **Mermaid:** a code field and the live diagram side by side, stacked under 720px. A parse
    error shows under the field and keeps the last good diagram.
  - **Chart:**
    - 종류 is a segmented control for 막대, 선 and 원.
    - 제목 is a text field.
    - 데이터 chooses between a table in this note and inline data. For a table in this note,
      a picker lists the note's tagged tables plus "새 표 만들기", which inserts a tagged sample
      table above the chart. The table itself is edited as a Notion table (decision 4), and
      the chart redraws as cells change.
    - 방향 sets the layout (rows or columns) and appears only for table data.
    - Unknown keys already in the fence (obsidian-charts' `width` and others) are kept on
      write.
    - `/chart` inserts the sample table and the chart, then opens the chart's panel.
  - **Query:**
    - Form fields for the query's common terms: 폴더 (`path:`), 태그 (`tag:`), 종류 (`type:`),
      정렬 (`sort:`) and 개수 (`limit:`).
    - Under "고급", the whole query line as text, for terms the form does not cover. The form
      and that line stay in sync.
    - The existing bake action stays.
  - **Plugin fence:** a plain text field of the body with the live result above. This is the
    fallback for any fence without its own panel.
- Fenced code blocks that are not registry blocks (a ```` ```js ```` block) stay as they are.

## Out of scope (named so nobody widens it)

- Inline marks inside paragraphs: `**`, `[[`, `` ` `` still show while the caret is inside the
  span, as the owner decided on 2026-09-25.
- Callouts and toggles keep their current text editing.
- New block types.

## Acceptance

- vitest (node):
  - The table model: parse, cell edits, add and remove row and column, alignment, `|`
    escaping, quote and list leads, and a byte-for-byte round-trip of an untouched table.
  - Each panel's source ↔ form mapping keeps unknown chart keys and keeps query terms the form
    does not know.
  - The tag-line hiding rule.
  - The block selection keys: Enter, Backspace, ArrowUp, ArrowDown and Escape on a selected
    block.
  - `editorMode` migration.
  - The old reveal-on-caret pins rewritten to this contract.
- Browser (`?mock=1`, ko + light at 1280×900 and en + dark at 1024×700). Screenshots must be
  looked at, not only asserted on:
  - `/table` then type in cells with Tab and Enter: no `|` or `---` is ever visible, and the
    file holds the expected GFM.
  - Add and delete a row and a column from the controls.
  - `/chart`: the panel opens. Change 종류 and 제목, then edit a data cell: the chart redraws,
    no fence or `^tag` is visible, and the file holds the expected fence.
  - Math, mermaid and query panels: open, edit, close. The result updates and no fence is
    visible.
  - Select a block with ArrowDown, then Backspace removes it, and ⌘Z brings it back.
  - The Reader top bar has no 쓰기 / 읽기 toggle. ⋯ → 마크다운 원문 편집 shows the source and
    the notice leads back. A `raw/` file opens read-only.
  - The existing editor suite (`editor-audit/10-verify-blocks.mjs`) is updated where it pinned
    reveal-on-caret, and otherwise stays all-PASS.
- Not checkable here, and reported as such: Korean IME composition in WKWebView. The owner checks
  it in the installed app.
