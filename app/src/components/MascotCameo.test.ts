import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// UX S44: the MYCO tip bubble covered the inspector's main button. PageGraph
// is too heavy to render here, so this reads its source: the cameo is off
// while a note is selected (the inspector is open).
describe("MascotCameo gate", () => {
  const src = readFileSync(
    new URL("../pages/PageGraph.tsx", import.meta.url),
    "utf8",
  );
  const gate = src.slice(
    src.indexOf("<MascotCameo"),
    src.indexOf("sceneRef={sceneRef}", src.indexOf("<MascotCameo")),
  );

  it("stays away while the inspector is open", () => {
    expect(gate).toContain("!selected");
  });
});
