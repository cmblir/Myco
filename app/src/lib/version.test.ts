// The app version is declared in three places that nothing ties together:
// package.json (the browser fallback in About), src-tauri/Cargo.toml (the crate)
// and tauri.conf.json (what the bundle and getVersion() report). Every release
// before 0.4.0 shipped as "0.3.1" partly because a bump can land in one file and
// miss another with no build error anywhere.
//
// This is that missing tie: a partial bump fails here, naming the files that
// disagree.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function jsonVersion(relative: string): string {
  return (JSON.parse(read(relative)) as { version: string }).version;
}

// The [package] version, i.e. the first `version = "..."` in the manifest — not
// a dependency's. A regex beats a TOML parser for one field the file declares on
// its third line.
function cargoVersion(relative: string): string {
  const match = /^version = "(.+)"$/m.exec(read(relative));
  if (!match) throw new Error(`no [package] version in ${relative}`);
  return match[1];
}

describe("declared app version", () => {
  it("is the same in package.json, Cargo.toml and tauri.conf.json", () => {
    const pkg = jsonVersion("../../package.json");
    expect({
      "package.json": pkg,
      "src-tauri/Cargo.toml": cargoVersion("../../src-tauri/Cargo.toml"),
      "src-tauri/tauri.conf.json": jsonVersion("../../src-tauri/tauri.conf.json"),
    }).toEqual({
      "package.json": pkg,
      "src-tauri/Cargo.toml": pkg,
      "src-tauri/tauri.conf.json": pkg,
    });
  });

  it("is plain semver, so the updater can compare it", () => {
    expect(jsonVersion("../../package.json")).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
