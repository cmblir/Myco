import { afterEach, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { reviewMapRefresh } from "./reviewMapRefresh";
import { useDialogStore } from "../stores/dialogStore";
import { useVaultStore } from "../stores/vaultStore";

afterEach(() => useDialogStore.getState().close(null));
it("shows preserved notes in a review and accepts only an explicit decision", async () => {
  const pending = reviewMapRefresh({ path: "wiki/maps/synthetic.md", before: "Old\nHuman note", after: "New\nHuman note" }, () => true);
  const request = useDialogStore.getState().request!;
  expect(renderToStaticMarkup(createElement(Fragment, null, request.body))).toContain("Human note");
  useDialogStore.getState().close("ok");
  await expect(pending).resolves.toBe(true);
});
it("closes its review when the originating vault is no longer current", async () => {
  let active = true;
  const pending = reviewMapRefresh({ path: "wiki/maps/synthetic.md", before: "Old", after: "New" }, () => active);
  active = false;
  useVaultStore.setState({});
  await expect(pending).resolves.toBe(false);
  expect(useDialogStore.getState().request).toBeNull();
});
it("settles a replaced review without closing the new dialog", async () => {
  const pending = reviewMapRefresh({ path: "wiki/maps/synthetic.md", before: "Old", after: "New" }, () => true);
  const replacement = { kind: "confirm" as const, title: "Synthetic other dialog", resolve: () => undefined };
  useDialogStore.getState().open(replacement);
  await expect(pending).resolves.toBe(false);
  expect(useDialogStore.getState().request).toBe(replacement);
});
it("does not replace another dialog and keeps long output in bounded diff blocks", async () => {
  const pending = reviewMapRefresh({ path: "wiki/maps/synthetic.md", before: "x ".repeat(1500), after: "y ".repeat(1500) }, () => true);
  const request = useDialogStore.getState().request!;
  await expect(reviewMapRefresh({ path: "other", before: "", after: "" }, () => true)).rejects.toMatchObject({ status: "pending" });
  expect(useDialogStore.getState().request).toBe(request);
  expect(renderToStaticMarkup(createElement(Fragment, null, request.body))).toContain("y ".repeat(1500));
  useDialogStore.getState().close(null);
  await expect(pending).resolves.toBe(false);
});
