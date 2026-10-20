import { describe, expect, it, vi } from "vitest";

// Decisions 1 and 3 of the 2026-10-02 machine-session spec: distill and the
// session importer tell myco's own CLI runs apart by how the prompt opens
// (mycoPromptHeads.json). That holds only while each sender's prompt still
// opens with its head, and only this test says so: a word put in front of
// one passes every other test and turns its runs back into sessions. What
// complete() adds to a prompt is pinned in chat.test.ts.

/** The first message of every complete() call. */
const sent: string[] = [];
const complete = vi.fn(async (args: { messages: { content: string }[] }) => {
  sent.push(args.messages[0].content);
  throw new Error("stop"); // the prompt is all this test wants
});
vi.mock("./chat", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  complete: (args: { messages: { content: string }[] }) => complete(args),
  getActiveModel: async () => ({ provider: "codex-cli", model: "" }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import HEADS from "./mycoPromptHeads.json";
import { ipc } from "./ipc";
import { roleFixture, selectedRolesFixture } from "./modelRoles.testSupport";
import { useVaultStore } from "../stores/vaultStore";
import { useReflectStore } from "../stores/reflectStore";
import { useLintStore } from "../stores/lintStore";
import { INGEST_PROMPT } from "../stores/ingestStore";
import { SYSTEM_PREAMBLE } from "../stores/queryStore";
import { buildIngestPlanPrompt } from "./ingestPlan";
import { DIGEST_SYSTEM } from "./sessionDigest";
import { MONTHLY_SYSTEM, ROLLUP_SYSTEM } from "./rollup";
import { generateCards, generateQuiz } from "./study";
import { draftMap } from "./maps";

describe("myco's prompt heads", () => {
  it("every frontend prompt opens with its head, and every frontend head is sent", async () => {
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: "/v", openingToken: "native-test" });
    let lintProvider = "codex-cli";
    vi.spyOn(ipc, "captureModelRole").mockImplementation(async (origin, role, usage) =>
      roleFixture(role, role === "lint" ? lintProvider : "codex-cli", "", origin, usage));
    const settings = vi
      .spyOn(ipc, "getSettings")
      .mockResolvedValue({ query_provider: "codex-cli", model_roles: selectedRolesFixture({
        reflect: { providerId: "codex-cli", modelId: "" }, lint: { providerId: "codex-cli", modelId: "" },
        study: { providerId: "codex-cli", modelId: "" }, audio: { providerId: "codex-cli", modelId: "" },
        organization: { providerId: "codex-cli", modelId: "" },
      }) } as never);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockImplementation(async (path) => ({
      path,
      raw: "Synthetic note for prompt-head checks.",
      content: "Synthetic note for prompt-head checks.",
      frontmatter: null,
    }));
    const stream = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "report", stderr: "", status: 0 });
    const settle = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);

    // Senders whose prompt is private: drive them, read what they send.
    await settle(useReflectStore.getState().runReflect());
    await settle(useLintStore.getState().runLint());
    await settle(generateCards("/v", "a note"));
    await settle(generateQuiz("/v", "a note"));
    await settle(draftMap("/v", "rope", ["wiki/a.md"]));
    // Lint on the Claude CLI streams its prompt instead of calling complete().
    lintProvider = "anthropic-cli";
    settings.mockResolvedValue({ query_provider: "anthropic-cli", model_roles: selectedRolesFixture({
      lint: { providerId: "anthropic-cli", modelId: "" },
    }) } as never);
    await settle(useLintStore.getState().runLint());

    const prompts = [
      ...sent,
      ...stream.mock.calls.map((c) => c[1]),
      // Exported: the senders pass these as their first message.
      INGEST_PROMPT("note", "Note"),
      buildIngestPlanPrompt("a source", []),
      DIGEST_SYSTEM,
      ROLLUP_SYSTEM,
      MONTHLY_SYSTEM,
      SYSTEM_PREAMBLE,
    ];
    const used = new Set<string>();
    for (const prompt of prompts) {
      const key = Object.entries(HEADS).find(([, head]) => prompt.startsWith(head))?.[0];
      expect(key, `no head opens: ${prompt.slice(0, 60)}`).toBeDefined();
      if (key) used.add(key);
    }
    // `digest` has no sender any more (its writer was removed as unused); the
    // head stays so the sessions it wrote are still told apart as myco's.
    // Audio is still a live sender, now owned by audio_overview/generation.rs.
    // Its native generation tests assert the effective SYSTEM prompt head.
    expect([...used].sort()).toEqual(Object.keys(HEADS).filter((k) => k !== "digest" && k !== "audioOverview").sort());
  });

  it("retains the live native Audio head for importer recognition", () => {
    expect(HEADS.audioOverview).toBe("You are myco's audio-overview writer.");
  });
});
