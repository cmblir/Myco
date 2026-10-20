// A step's Next is unavailable while the step works (the index builds), but it
// must stay focusable: a focused button that turns `disabled` is blurred —
// Chromium then refocused the header's Skip, so the next Enter ended
// onboarding, and WebKit dropped focus to <body>, where Escape never reached
// the wizard. aria-disabled keeps focus on Next; its click does nothing yet.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import OnboardingWizard from "./OnboardingWizard";
import { STRINGS } from "../lib/i18n";

const t = STRINGS.ko;
// SSR reads the stores' initial state: step 0 with no vault linked yet.
const html = (): string => renderToStaticMarkup(h(OnboardingWizard, { t, onClose: () => undefined }));

describe("OnboardingWizard", () => {
  it("marks an unavailable Next aria-disabled, never disabled, so it keeps focus", () => {
    const next = html().match(new RegExp(`<button[^>]*>${t.ob_next}</button>`))?.[0] ?? "";
    expect(next).toContain('aria-disabled="true"');
    expect(next).not.toMatch(/\sdisabled=""/);
  });

  // UX S18: three steps, counted in words a new user reads, Skip on each.
  it("opens on the folder step as 1/3, with Skip", () => {
    const out = html();
    expect(out).toContain(">1/3<");
    expect(out).toContain(t.ob_s1_title);
    expect(out).toContain(`>${t.ob_skip}</button>`);
  });

  // Session import and vault history moved to Home's guide card: a first run
  // no longer asks about Claude Code before the user has written anything.
  it("offers no session import or history step", () => {
    expect(html()).not.toContain("Claude Code");
    const src = readFileSync(resolve(__dirname, "OnboardingWizard.tsx"), "utf8");
    expect(src).not.toMatch(/useImportStore|initVaultHistory|ob_imp_|ob_hist_/);
  });
});
