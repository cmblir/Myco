import { describe, expect, it } from "vitest";
import { storageProvider } from "./storageStatus";

describe("storageProvider", () => {
  it("names iCloud Drive and Dropbox from where the vault folder is", () => {
    expect(storageProvider("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Notes")).toBe("icloud");
    expect(storageProvider("/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/V")).toBe("icloud");
    expect(storageProvider("/Users/x/Library/CloudStorage/Dropbox/Notes")).toBe("dropbox");
    expect(storageProvider("/Users/x/Dropbox/Notes")).toBe("dropbox");
  });

  // ~/Documents can be iCloud-backed ("Desktop & Documents Folders") with no
  // trace in the path, so an unrecognised path makes no claim at all.
  it("claims nothing for a path it cannot tell", () => {
    expect(storageProvider("/Users/x/Documents/Notes")).toBeNull();
    expect(storageProvider("/Users/x/NotDropbox/Notes")).toBeNull();
    expect(storageProvider("")).toBeNull();
  });
});
