// MycoSpin's first markup: the poster, and no video source until the viewer
// has been on screen (effects do not run under react-dom/server).
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MycoSpin } from "./MycoSpin";

describe("MycoSpin", () => {
  it("starts as its skin's poster, focusable, with nothing loading yet", () => {
    const html = renderToStaticMarkup(h(MycoSpin, { skin: "white" }));
    expect(html).toMatch(/poster="[^"]*spin-white\.poster/);
    expect(html).not.toMatch(/ src=/);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-busy="true"');
  });
});
