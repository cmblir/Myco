// Wire checks only; synthetic role DTOs do not confer native authority.
import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc } from "./ipc";
import { roleFixture } from "./modelRoles.testSupport";

const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
const request = {
  path: "/synthetic/source.png",
  prompt: "Synthetic image description request.",
  origin,
  roleSnapshot: roleFixture(
    "compilation",
    "openai-api",
    "synthetic-vision",
    origin,
  ),
  requestId: "synthetic-image-request",
};
beforeEach(() => invoke.mockClear());

it("serializes one bound image request without legacy Query provider/model fields", async () => {
  await ipc.describeImage(request);
  expect(invoke).toHaveBeenCalledWith("describe_image", { request });
  expect(invoke.mock.calls[0][1]).not.toHaveProperty("provider");
  expect(invoke.mock.calls[0][1]).not.toHaveProperty("model");
});

it("cancels only the supplied image request and its captured opening", async () => {
  const cancel = ipc.cancelImageIngest;
  expect(typeof cancel).toBe("function");
  await cancel(origin, request.requestId);
  expect(invoke).toHaveBeenCalledWith("cancel_image_ingest", {
    origin,
    requestId: request.requestId,
  });
});
