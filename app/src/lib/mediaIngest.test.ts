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
  classifyInboxEntry,
  isImageFile,
  isMediaFile,
  isSupportedSource,
  sourceTextFor,
  IMAGE_INGEST_PROMPT,
} from "./mediaIngest";
import { roleFixture } from "./modelRoles.testSupport";

const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
const imageContext = {
  origin,
  roleSnapshot: roleFixture(
    "compilation",
    "openai-api",
    "synthetic-vision",
    origin,
  ),
  requestId: "synthetic-image-request",
};

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

// Q4 item 20a — one classification for every file the inbox can hold, so the
// auto-ingest pass and the pending panel agree on what is routable.
describe("classifyInboxEntry", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(classifyInboxEntry("note.md")).toBe("md");
    expect(classifyInboxEntry("paper.PDF")).toBe("extract");
    expect(classifyInboxEntry("slides.pptx")).toBe("extract");
    expect(classifyInboxEntry("page.html")).toBe("extract");
    expect(classifyInboxEntry("notes.txt")).toBe("extract");
    expect(classifyInboxEntry("shot.png")).toBe("image");
    expect(classifyInboxEntry("talk.m4a")).toBe("media");
    expect(classifyInboxEntry("clip.MOV")).toBe("media");
  });

  it("marks unknown formats unsupported (epub, zip, no extension)", () => {
    expect(classifyInboxEntry("book.epub")).toBe("unsupported");
    expect(classifyInboxEntry("bundle.zip")).toBe("unsupported");
    expect(classifyInboxEntry("README")).toBe("unsupported");
  });

  it("isSupportedSource mirrors the classification", () => {
    expect(isSupportedSource("paper.pdf")).toBe(true);
    expect(isSupportedSource("book.epub")).toBe(false);
  });
});

describe("sourceTextFor dispatch", () => {
  const deps = imageContext;

  // The legacy Query provider/model arguments granted an unrelated route.
  // Images now require the initiating Compilation foreground context.
  it("forwards only the exact captured Compilation context to image ingest", async () => {
    describeImage.mockResolvedValue("a described chart");
    const text = await sourceTextFor("/x/fig.png", deps);
    expect(text).toBe("a described chart");
    expect(describeImage).toHaveBeenCalledWith({
      ...imageContext,
      path: "/x/fig.png",
      prompt: IMAGE_INGEST_PROMPT,
    });
    expect(readExternalText).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { provider: "openai-api", model: "synthetic-legacy-query" },
    {
      ...imageContext,
      roleSnapshot: roleFixture(
        "ask",
        "openai-api",
        "synthetic-vision",
        origin,
      ),
    },
    {
      ...imageContext,
      roleSnapshot: roleFixture(
        "compilation",
        "openai-api",
        "synthetic-vision",
        origin,
        "automatic",
      ),
    },
    {
      ...imageContext,
      origin: { ...origin, openingToken: "different-opening" },
    },
    { ...imageContext, requestId: "" },
  ])(
    "rejects a missing or unrelated image context before any extraction: %j",
    async (context) => {
      describeImage.mockResolvedValue("Synthetic unauthorized description");
      await expect(
        sourceTextFor("/synthetic/image.png", context as never),
      ).rejects.toThrow();
      expect(describeImage).not.toHaveBeenCalled();
      expect(readExternalText).not.toHaveBeenCalled();
      expect(transcribeMedia).not.toHaveBeenCalled();
    },
  );

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
