import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EverydayHome from "./EverydayHome";
import { STRINGS } from "../lib/i18n";

describe("returning Home actions", () => {
  it("keeps capture and writing available without the introductory hero on return", () => {
    const html = renderToStaticMarkup(createElement(EverydayHome, { t: STRINGS.ko, hasVault: true, compact: true }));
    expect(html).toContain(STRINGS.ko.home_add);
    expect(html).toContain(STRINGS.ko.home_write);
    expect(html).not.toContain(STRINGS.ko.home_title);
    expect(html).not.toContain("everyday-hero");
  });
  it("keeps first-visit and no-vault orientation", () => {
    const first = renderToStaticMarkup(createElement(EverydayHome, { t: STRINGS.ko, hasVault: true }));
    const noVault = renderToStaticMarkup(createElement(EverydayHome, { t: STRINGS.ko, hasVault: false, compact: true }));
    expect(first).toContain(STRINGS.ko.home_intro);
    expect(noVault).toContain(STRINGS.ko.home_choose_vault);
    expect(noVault).toContain(STRINGS.ko.home_no_vault);
  });
});
