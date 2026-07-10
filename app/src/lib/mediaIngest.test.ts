import { describe, expect, it, vi, beforeEach } from "vitest";

const describeImage = vi.fn();
const transcribeMedia = vi.fn();
const readExternalText = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    describeImage: (...a: unknown[]) => describeImage(...a),
    transcribeMedia: (...a: unknown[]) => transcribeMedia(...a),
    readExternalText: (...a: unknown[]) => readExternalText(...a),
  },
}));

import {
  isImageFile,
  isMediaFile,
  sourceTextFor,
  IMAGE_INGEST_PROMPT,
} from "./mediaIngest";

beforeEach(() => {
  describeImage.mockReset();
  transcribeMedia.mockReset();
  readExternalText.mockReset();
});

describe("kind detection", () => {
  it("recognizes images", () => {
    expect(isImageFile("/a/b/diagram.png")).toBe(true);
    expect(isImageFile("photo.JPEG")).toBe(true);
    expect(isImageFile("notes.pdf")).toBe(false);
  });
  it("recognizes audio/video", () => {
    expect(isMediaFile("talk.mp3")).toBe(true);
    expect(isMediaFile("lecture.MP4")).toBe(true);
    expect(isMediaFile("paper.docx")).toBe(false);
  });
});

describe("sourceTextFor dispatch", () => {
  const deps = { provider: "anthropic-api", model: "claude" };

  it("routes images to the vision provider", async () => {
    describeImage.mockResolvedValue("a described chart");
    const text = await sourceTextFor("/x/fig.png", deps);
    expect(text).toBe("a described chart");
    expect(describeImage).toHaveBeenCalledWith(
      "anthropic-api",
      "claude",
      "/x/fig.png",
      IMAGE_INGEST_PROMPT,
    );
    expect(readExternalText).not.toHaveBeenCalled();
  });

  it("routes audio/video to whisper", async () => {
    transcribeMedia.mockResolvedValue("spoken transcript");
    expect(await sourceTextFor("/x/talk.m4a", deps)).toBe("spoken transcript");
    expect(transcribeMedia).toHaveBeenCalledWith("/x/talk.m4a");
  });

  it("routes documents to text extraction", async () => {
    readExternalText.mockResolvedValue("doc text");
    expect(await sourceTextFor("/x/paper.pdf", deps)).toBe("doc text");
    expect(readExternalText).toHaveBeenCalledWith("/x/paper.pdf");
  });
});
