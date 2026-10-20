import { describe, expect, it } from "vitest";
import { STRINGS } from "../lib/i18n";
import { statusChipName } from "./TaskBoard";

// The card's status chip (UX S52) is how a finger, or anyone who cannot drag,
// moves a card: it must say what it is and where the card stands.
describe("statusChipName", () => {
  it("names the field and the card's status", () => {
    expect(statusChipName(STRINGS.ko, "todo")).toBe("상태: 할 일");
    expect(statusChipName(STRINGS.en, "done")).toBe("Status: Done");
  });
});
