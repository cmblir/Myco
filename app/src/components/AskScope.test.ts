// The Ask composer's scope chip (UX S33): the scope in plain words, and the
// three choices with a line each, the default first. Static markup, as
// AskHistory.test.ts does.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AskScopePicker from "./AskScope";
import { STRINGS } from "../lib/i18n";
import type { AskScope } from "../lib/ipc";

const t = STRINGS.ko;
const render = (scope: AskScope): string =>
  renderToStaticMarkup(
    h(AskScopePicker, { t, scope, disabled: false, onChange: () => undefined }),
  );

describe("AskScopePicker", () => {
  it("names the scope on the chip", () => {
    const html = render("sessions");
    expect(html).toMatch(
      new RegExp(
        `<summary[^>]*>${t.q_scope_chip.replace("{scope}", t.q_scope_sessions)}`,
      ),
    );
  });

  it("lists the default first, each choice with its line, the current one pressed", () => {
    const html = render("all");
    const at = (s: string): number => html.indexOf(s);
    expect(at(t.q_scope_wiki_hint)).toBeGreaterThan(-1);
    expect(at(t.q_scope_wiki_hint)).toBeLessThan(at(t.q_scope_sessions_hint));
    expect(at(t.q_scope_sessions_hint)).toBeLessThan(at(t.q_scope_all_hint));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(`aria-pressed="true"[^>]*>.*?${t.q_scope_all}<`),
    );
  });
});
