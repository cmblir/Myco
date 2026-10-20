import { expect, it } from "vitest";
import { useUIStore } from "../stores/uiStore";

it("persists and rehydrates the UI store in the Node test environment", async () => {
  useUIStore.getState().setRoute("graph");
  expect(JSON.parse(localStorage.getItem("myco-ui") ?? "null")).toMatchObject({
    state: { route: "graph" },
    version: 3,
  });

  localStorage.setItem(
    "myco-ui",
    JSON.stringify({ state: { route: "query" }, version: 3 }),
  );
  await useUIStore.persist.rehydrate();
  expect(useUIStore.getState().route).toBe("query");
});
