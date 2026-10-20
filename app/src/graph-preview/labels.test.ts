import { expect, it } from "vitest";
import { placeLabels } from "./labels";
import type { PreviewNode } from "./model";

it("keeps the selected label first even when a higher-degree note collides", () => {
  const nodes = ["hub", "selected"].map(
    (id, index): PreviewNode => ({
      id,
      label: "a-long-note-title-in-the-same-place",
      degree: index ? 1 : 50,
      community: 0,
      color: "#ffffff",
      positions: {
        terrain: { x: 0, y: 0 },
        ribbon: { x: 0, y: 0 },
        city: { x: 0, y: 0 },
      },
    }),
  );
  const labels = placeLabels(
    nodes,
    { hub: { x: 50, y: 50 }, selected: { x: 50, y: 50 } },
    "selected",
  );
  expect([...labels.keys()][0]).toBe("selected");
  expect(labels.get("selected")!.x).toBe(12);
  expect(labels.get("hub")!.x).not.toBe(labels.get("selected")!.x);
  expect(labels.get("selected")!.text.length).toBeLessThanOrEqual(27);
});
