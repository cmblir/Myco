import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import IngestReviewList from "./IngestReviewList";

it("shows actual titles, conservative change labels and the original source independently of model plans", () => {
  const html = renderToStaticMarkup(createElement(IngestReviewList, {
    pages: [{ path: "wiki/a.md", change: "changed" }], root: "/v", sourcePath: "raw/a-2.md",
    meta: { "/v/wiki/a.md": { title: "Synthetic human title" } }, lang: "en", onOpen: () => undefined,
  }));
  expect(html).toContain("Synthetic human title");
  expect(html).toContain("wiki/a.md");
  expect(html).toContain("Changed");
  expect(html).not.toContain("Created");
  expect(html).toContain("raw/a-2.md");
  expect(html).toContain("View original source");
});
