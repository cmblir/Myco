import { describe, expect, it } from "vitest";
import {
  importWebLink,
  looksLikeWebLink,
  msgAfterEdit,
  nextAutoTitle,
  webLinkErrorKey,
} from "./webLink";
import type { SecretScanReport, WebPage } from "./ipc";

describe("looksLikeWebLink", () => {
  it("accepts one pasted http(s) link", () => {
    expect(looksLikeWebLink("https://example.com/post")).toBe(true);
    expect(looksLikeWebLink("  http://example.com/a?b=1  ")).toBe(true);
  });

  it("leaves YouTube links to the transcript button", () => {
    expect(looksLikeWebLink("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(looksLikeWebLink("https://youtu.be/abc")).toBe(false);
  });

  it("ignores text that merely contains a link, and other schemes", () => {
    expect(looksLikeWebLink("read https://example.com later")).toBe(false);
    expect(looksLikeWebLink("https://example.com\nmore text")).toBe(false);
    expect(looksLikeWebLink("file:///etc/passwd")).toBe(false);
    expect(looksLikeWebLink("example.com")).toBe(false);
    expect(looksLikeWebLink("")).toBe(false);
  });
});

describe("webLinkErrorKey", () => {
  it("maps every Rust refusal code to its own message", () => {
    const codes = [
      "bad_url", "scheme", "credentials", "blocked", "resolve", "redirect",
      "redirects", "not_html", "too_large", "timeout", "network", "empty",
      "secret", "pii", "scan",
    ];
    const keys = codes.map((c) => webLinkErrorKey(c).key);
    expect(new Set(keys).size).toBe(codes.length);
    expect(keys).not.toContain("ing_web_err_other");
  });

  it("carries the HTTP status number", () => {
    expect(webLinkErrorKey("status:404")).toEqual({ key: "ing_web_err_status", n: "404" });
  });

  it("falls back for anything unknown (a raw Tauri error string)", () => {
    expect(webLinkErrorKey("Error: boom").key).toBe("ing_web_err_other");
  });
});

const page: WebPage = { url: "https://example.com/final", title: "A post", markdown: "Body text." };
const clean: SecretScanReport = { secrets: [], pii: [] };

describe("importWebLink", () => {
  it("returns the page as an ingest body that names its source", async () => {
    const r = await importWebLink("https://example.com/p", {
      fetchPage: async () => page,
      scan: async () => clean,
      piiQuarantine: false,
    });
    expect(r).toEqual({
      ok: true,
      title: "A post",
      body: "Source: https://example.com/final\n\nBody text.",
      piiWarn: false,
    });
  });

  it("turns a Rust refusal into its code", async () => {
    const r = await importWebLink("http://10.0.0.1/", {
      fetchPage: () => Promise.reject("blocked"),
      scan: async () => clean,
      piiQuarantine: false,
    });
    expect(r).toEqual({ ok: false, code: "blocked" });
  });

  it("refuses a page with a secret in it, whatever the PII setting", async () => {
    const r = await importWebLink("https://example.com/p", {
      fetchPage: async () => page,
      scan: async () => ({ secrets: ["aws_key"], pii: [] }),
      piiQuarantine: false,
    });
    expect(r).toEqual({ ok: false, code: "secret" });
  });

  it("holds PII only when the quarantine is on, otherwise warns", async () => {
    const deps = {
      fetchPage: async () => page,
      scan: async () => ({ secrets: [], pii: ["phone"] }),
    };
    expect(await importWebLink("u", { ...deps, piiQuarantine: true })).toEqual({ ok: false, code: "pii" });
    const warned = await importWebLink("u", { ...deps, piiQuarantine: false });
    expect(warned.ok && warned.piiWarn).toBe(true);
  });

  it("fails closed when the scan itself fails", async () => {
    const r = await importWebLink("https://example.com/p", {
      fetchPage: async () => page,
      scan: () => Promise.reject(new Error("scan down")),
      piiQuarantine: false,
    });
    expect(r).toEqual({ ok: false, code: "scan" });
  });

  it("scans the page title too — it becomes the raw/ file's heading", async () => {
    const titled = { ...page, title: "token ghp_FAKE1234", markdown: "harmless body" };
    const scan = async (text: string) =>
      text.includes("ghp_") ? { secrets: ["github_token"], pii: [] } : clean;
    expect(
      await importWebLink("u", { fetchPage: async () => titled, scan, piiQuarantine: false }),
    ).toEqual({ ok: false, code: "secret" });
    const piiTitle = { ...page, title: "call 010-0000-0000" };
    const piiScan = async (text: string) =>
      text.includes("010-") ? { secrets: [], pii: ["phone"] } : clean;
    expect(
      await importWebLink("u", { fetchPage: async () => piiTitle, scan: piiScan, piiQuarantine: true }),
    ).toEqual({ ok: false, code: "pii" });
  });
});

describe("nextAutoTitle", () => {
  it("fills an empty title", () => {
    expect(nextAutoTitle("", "", "Page A")).toBe("Page A");
  });

  it("replaces a title an earlier import filled in", () => {
    expect(nextAutoTitle("Page A", "Page A", "Page B")).toBe("Page B");
  });

  it("keeps a title the user typed", () => {
    expect(nextAutoTitle("My title", "Page A", "Page B")).toBe("My title");
  });
});

describe("msgAfterEdit", () => {
  it("drops a refusal once the box is edited — it was about the old link", () => {
    expect(msgAfterEdit({ text: "blocked", isError: true })).toBeNull();
  });

  it("keeps the PII notice — it is about the imported text still in the box", () => {
    const pii = { text: "has personal details", isError: false };
    expect(msgAfterEdit(pii)).toBe(pii);
  });

  it("keeps no message as none", () => {
    expect(msgAfterEdit(null)).toBeNull();
  });
});
