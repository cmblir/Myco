// updateBanner is the whole rule for the app-wide update banner: it only ever
// shows for an update that actually exists, and only while that update is coming
// down or waiting for a restart. Everything else (checking, up to date, no
// channel, failure) belongs in Settings -> About, where the user asked.

import { describe, expect, it } from "vitest";
import { updateBanner } from "./updateStore";
import type { UpdateStatus } from "./updateStore";

const found = (status: UpdateStatus) => ({
  status,
  version: "0.5.0",
  dismissed: false,
});

describe("updateBanner", () => {
  it("announces a staged update and points at a restart", () => {
    expect(updateBanner(found("ready"))).toEqual({
      kind: "ready",
      version: "0.5.0",
    });
  });

  it("shows the version while it is still downloading", () => {
    expect(updateBanner(found("downloading"))).toEqual({
      kind: "downloading",
      version: "0.5.0",
    });
  });

  it("stays hidden once dismissed, even with an update staged", () => {
    expect(updateBanner({ ...found("ready"), dismissed: true })).toEqual({
      kind: "hidden",
    });
  });

  it("stays hidden for every state that is not a pending update", () => {
    const quiet: UpdateStatus[] = [
      "idle",
      "unconfigured",
      "unavailable",
      "checking",
      "current",
      "error",
    ];
    for (const status of quiet) {
      expect(updateBanner({ status, version: null, dismissed: false })).toEqual({
        kind: "hidden",
      });
    }
  });

  // Defensive: a "ready" with no version would render "v undefined".
  it("stays hidden when a status implies an update but no version came back", () => {
    expect(
      updateBanner({ status: "ready", version: null, dismissed: false }),
    ).toEqual({ kind: "hidden" });
  });
});
