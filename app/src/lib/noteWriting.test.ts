import { describe, expect, it, vi } from "vitest";
import {
  requestNoteWriting,
  subscribeNoteWriting,
  takeNoteWritingRequest,
} from "./noteWriting";

describe("note writing requests", () => {
  it("waits for the matching note and is consumed only once", () => {
    requestNoteWriting("/v/new.md");
    expect(takeNoteWritingRequest("/v/old.md")).toBe(false);
    expect(takeNoteWritingRequest("/v/new.md")).toBe(true);
    expect(takeNoteWritingRequest("/v/new.md")).toBe(false);
  });

  it("keeps only the latest creation request", () => {
    requestNoteWriting("/v/first.md");
    requestNoteWriting("/v/second.md");
    expect(takeNoteWritingRequest("/v/first.md")).toBe(false);
    expect(takeNoteWritingRequest("/v/second.md")).toBe(true);
  });

  it("notifies repeat requests for the same mounted note until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNoteWriting(listener);
    requestNoteWriting("/v/open.md");
    expect(takeNoteWritingRequest("/v/open.md")).toBe(true);
    requestNoteWriting("/v/open.md");
    expect(takeNoteWritingRequest("/v/open.md")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    requestNoteWriting("/v/open.md");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(takeNoteWritingRequest("/v/open.md")).toBe(true);
  });

  it("unsubscribing before consumption leaves the request for the next mount", () => {
    const unsubscribe = subscribeNoteWriting(() => undefined);
    requestNoteWriting("/v/remount.md");
    unsubscribe();
    expect(takeNoteWritingRequest("/v/remount.md")).toBe(true);
  });
});
