import { describe, expect, it } from "vitest";
import { assetFileName, imageExtFor, resolveImageSrc } from "./assets";

describe("assetFileName", () => {
  it("formats the local date and time, zero-padded", () => {
    expect(assetFileName(new Date(2026, 8, 2, 9, 5, 7), "png")).toBe(
      "20260902-090507.png",
    );
  });
});

describe("imageExtFor", () => {
  it("prefers the MIME type", () => {
    expect(imageExtFor("image/jpeg", "")).toBe("jpg");
    expect(imageExtFor("image/png", "x.jpg")).toBe("png");
  });

  it("falls back to an allow-listed name extension, case-insensitively", () => {
    expect(imageExtFor("", "Shot.PNG")).toBe("png");
    expect(imageExtFor("application/octet-stream", "a.webp")).toBe("webp");
  });

  it("rejects everything else", () => {
    expect(imageExtFor("image/svg+xml", "a.svg")).toBeNull();
    expect(imageExtFor("", "notes.md")).toBeNull();
    expect(imageExtFor("", "png")).toBeNull();
  });
});

describe("resolveImageSrc", () => {
  const root = "/v";
  const noteDir = "/v/wiki";

  it("resolves bare and slash-rooted paths against the vault root", () => {
    expect(resolveImageSrc("assets/a.png", root, noteDir)).toBe("/v/assets/a.png");
    expect(resolveImageSrc("/assets/a.png", root, noteDir)).toBe("/v/assets/a.png");
  });

  it("resolves ./ and ../ against the note's directory", () => {
    expect(resolveImageSrc("./a.png", root, noteDir)).toBe("/v/wiki/a.png");
    expect(resolveImageSrc("../raw/a.png", root, noteDir)).toBe("/v/raw/a.png");
  });

  it("leaves scheme-prefixed sources alone", () => {
    expect(resolveImageSrc("https://x.test/a.png", root, noteDir)).toBeNull();
    expect(resolveImageSrc("data:image/png;base64,AAAA", root, noteDir)).toBeNull();
    expect(resolveImageSrc("asset://localhost/a.png", root, noteDir)).toBeNull();
  });

  it("decodes percent-escapes", () => {
    expect(resolveImageSrc("my%20img.png", root, noteDir)).toBe("/v/my img.png");
  });
});
