import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PageIngest from "./PageIngest";
import { STRINGS } from "../lib/i18n";
import type * as IngestStoreModule from "../stores/ingestStore";
import type * as VaultStoreModule from "../stores/vaultStore";
import type * as MascotClipsModule from "../lib/mascotClips";

// Synthetic completed receipts exercise the real page's link visibility;
// no native publication or external application is invoked.
const fixture = vi.hoisted(() => ({
  vault: {} as Partial<ReturnType<typeof VaultStoreModule.useVaultStore.getState>>,
  ingest: {} as Partial<ReturnType<typeof IngestStoreModule.useIngestStore.getState>>,
}));

vi.mock("../lib/mascotClips", async (importOriginal) => ({
  ...await importOriginal<typeof MascotClipsModule>(),
  preloadStills: () => [],
}));

vi.mock("../stores/vaultStore", async (importOriginal) => {
  const actual = await importOriginal<typeof VaultStoreModule>();
  return { ...actual, useVaultStore: Object.assign(
    (selector: (state: ReturnType<typeof actual.useVaultStore.getState>) => unknown) =>
      selector({ ...actual.useVaultStore.getInitialState(), ...fixture.vault }),
    actual.useVaultStore,
  ) };
});

vi.mock("../stores/ingestStore", async (importOriginal) => {
  const actual = await importOriginal<typeof IngestStoreModule>();
  return { ...actual, useIngestStore: Object.assign(
    (selector: (state: ReturnType<typeof actual.useIngestStore.getState>) => unknown) =>
      selector({ ...actual.useIngestStore.getInitialState(), ...fixture.ingest }),
    actual.useIngestStore,
  ) };
});

describe("completed ingest review links", () => {
  beforeEach(() => {
    fixture.vault = { currentVault: { name: "Synthetic vault", path: "/synthetic/vault" },
      vaultToken: "synthetic-opening", isOpeningVault: false };
    fixture.ingest = { stage: "done", workflowStatus: "success", startedAt: 1, finishedAt: 2,
      vaultPath: "/synthetic/vault", reportPath: "/synthetic/vault/ingest-reports/result.md",
      review: { vaultToken: "synthetic-opening", sourcePath: "raw/source.md",
        pages: [{ path: "wiki/result.md", change: "changed" }] } };
  });

  const render = (): string => renderToStaticMarkup(createElement(PageIngest, { t: STRINGS.en }));

  it("keeps one page heading and a subordinate intake heading", () => {
    fixture.ingest = { stage: "idle", vaultPath: "/synthetic/vault" };
    const html = render();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<h2 class="u-hero__title" id="sv-judge-title">');
  });

  it("keeps report, note and source links for their originating opening", () => {
    const html = render();
    expect(html).toContain(STRINGS.en.ing_open_report);
    expect(html).toContain("wiki/result.md");
    expect(html).toContain("raw/source.md");
  });

  it.each(["reopened", "different", "opening", "closed"] as const)(
    "removes every completed-result link when the vault is %s", (state) => {
      if (state === "reopened") fixture.vault.vaultToken = "synthetic-next-opening";
      if (state === "different") fixture.vault.currentVault = { name: "Other synthetic vault", path: "/synthetic/other" };
      if (state === "opening") fixture.vault.isOpeningVault = true;
      if (state === "closed") fixture.vault.currentVault = null;
      const html = render();
      expect(html).not.toContain(STRINGS.en.ing_open_report);
      expect(html).not.toContain("wiki/result.md");
      expect(html).not.toContain("raw/source.md");
      expect(html).toContain(`disabled="">${STRINGS.en.ing_open_index}</button>`);
    },
  );
});
