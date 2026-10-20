// The reader's Note info rail, rendered under react-dom/server (node env).

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReaderRail, { ReaderRailSheet } from "./ReaderRail";
import type { AuthBadgeView } from "../lib/authorship";
import type { LinkSuggestionIO } from "../lib/linkSuggestions";
import { STRINGS } from "../lib/i18n";

const t = STRINGS.ko;
const rail = (authorship: AuthBadgeView | null): string =>
  renderToStaticMarkup(
    h(ReaderRail, {
      filePath: "/v/wiki/attention.md",
      fm: null,
      allTags: [],
      onPatch: () => undefined,
      headings: [],
      onSelectHeading: () => undefined,
      io: {} as LinkSuggestionIO,
      readOnly: false,
      authorship,
      t,
    }),
  );

// UX S14: "사람 62% · 에이전트 38% · 마지막 사람 손길 그저께" sat in every
// note's head. It is a fact about the note, so it lives with the others.
describe("authorship in the Note info rail", () => {
  it("shows the human/agent split and the last human touch", () => {
    const html = rail({ humanPct: 62, agentPct: 38, lastHumanRel: "그저께" });
    expect(html).toContain(`<span class="u-rail__title">${t.rd_auth_section}</span>`);
    expect(html).toContain("사람 62% · 에이전트 38%");
    expect(html).toContain("마지막 사람 손길 그저께");
    expect(html).toContain('style="width:62%"');
  });

  it("has no authorship section when the note has no record", () => {
    expect(rail(null)).not.toContain(t.rd_auth_section);
    expect(rail(null)).not.toContain("auth-badge");
  });
});

// Owner default 5: in a narrow window the rail is a sheet over the note, not
// a box laid over its text.
describe("the Note info sheet", () => {
  const sheet = renderToStaticMarkup(
    h(ReaderRailSheet, { t, onClose: () => undefined, children: h("p", null, "RAIL") }),
  );
  it("is a labelled modal dialog over a scrim", () => {
    expect(sheet).toContain('class="myco-modal__backdrop reader-sheet-backdrop"');
    expect(sheet).toContain('role="dialog"');
    expect(sheet).toContain('aria-modal="true"');
    expect(sheet).toContain(`aria-label="${t.rd_rail}"`);
    expect(sheet).toContain("RAIL");
  });
  it("has a close button for a pointer", () => {
    expect(sheet).toContain(`aria-label="${t.ui_close}"`);
  });
});
