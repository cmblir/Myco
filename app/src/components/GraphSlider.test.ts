import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GraphSlider from "./GraphSlider";

describe("graph numeric controls", () => {
  it.each([0.25, 0.75, 1.25])("preserves the quarter step %s in numeric entry", (value) => {
    const html = renderToStaticMarkup(createElement(GraphSlider, {
      label: "Playback", value, min: 0.25, max: 4, step: 0.25, onChange: vi.fn(),
    }));
    expect(html).toMatch(new RegExp(`type="number"[^>]+value="${value.toFixed(2)}"`));
  });
});
