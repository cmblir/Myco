import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RecoverySnapshotList } from "./MapRecoverySnapshots";
import { STRINGS } from "../lib/i18n";
import type { RecoveryRead } from "../lib/mapRecoverySnapshots";

const render = (read: RecoveryRead) =>
  renderToStaticMarkup(
    createElement(RecoverySnapshotList, { t: STRINGS.ko, read }),
  );
it("distinguishes loading, errors and empty retained records", () => {
  expect(render({ phase: "loading" })).toContain('role="status"');
  expect(render({ phase: "error", error: "Synthetic failure" })).toContain(
    'role="alert"',
  );
  expect(
    render({
      phase: "ready",
      snapshots: { path: "wiki/maps/synthetic.md", records: [] },
    }),
  ).toContain(STRINGS.ko.map_recovery_empty);
});
it("shows uncertainty and invalid records without interpreting saved text as HTML", () => {
  const html = render({
    phase: "ready",
    snapshots: {
      path: "wiki/maps/synthetic.md",
      records: [
        {
          recordId: "one",
          evidence: "currentObject",
          before: null,
          after: "Saved current",
        },
        {
          recordId: "two",
          evidence: "publicationUnknown",
          before: "<script>before</script>",
          after: "Human note",
        },
        {
          recordId: "three",
          evidence: "invalidRecord",
          before: null,
          after: null,
        },
      ],
    },
  });
  for (const text of [
    STRINGS.ko.map_recovery_current,
    STRINGS.ko.map_recovery_unknown,
    STRINGS.ko.map_recovery_invalid_note,
    STRINGS.ko.map_recovery_no_before,
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Human note");
  expect(html).not.toContain("<button");
});
