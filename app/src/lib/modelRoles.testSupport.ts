/** Synthetic DTO fixtures only; native private authority is tested independently. */
import type { RoleId, RoleSnapshot, ModelRoleSettings, RoleUsage } from "./modelRoles";
import type { AgentVaultSession } from "./ipc";
import { BUILTIN_CHAT_MODEL, BUILTIN_FAST_CHAT_MODEL } from "./providers";
export const syntheticOrigin = { vaultPath: "/v", openingToken: "synthetic-opening" };
export function roleFixture(role: RoleId, provider = "builtin-local", model = BUILTIN_CHAT_MODEL,
  origin: AgentVaultSession = syntheticOrigin, usage: RoleUsage = "foreground", effort = "(default)"): RoleSnapshot {
  return { snapshotId: "a".repeat(64), origin, role, authorizationRevision: "b".repeat(64), usage,
    routeSignature: { role, providerId: provider, modelId: model, effort, executionLocation: provider === "builtin-local" ? "in-process" : provider === "ollama" ? "loopback" : "remote",
      artifactRevision: null, artifactSha256: null, runtimeContract: "synthetic-only", signature: "c".repeat(64) } };
}

/** Explicit test choices only: connection/display fields are never inspected. */
export function selectedRolesFixture(choices: Partial<Record<RoleId, { providerId: string; modelId: string; effort?: string }>>): ModelRoleSettings {
  const settings = roleSettingsFixture();
  for (const [role, choice] of Object.entries(choices)) {
    const id = role as RoleId;
    settings.roles[id] = { ...settings.roles[id], ...choice,
      selection: choice.providerId === "builtin-local" ? "explicit-local" : "explicit-external" };
  }
  return settings;
}
export function roleSettingsFixture(): ModelRoleSettings {
  const ids: RoleId[] = ["ask", "compilation", "organization", "reflect", "lint", "study", "audio", "agent", "embedding", "transcription"];
  return { version: 2, roles: Object.fromEntries(ids.map(role => [role, { providerId: "builtin-local", modelId: role === "compilation" ? BUILTIN_FAST_CHAT_MODEL : role === "embedding" ? "e5-small-ko" : role === "transcription" ? "whisper-small" : BUILTIN_CHAT_MODEL,
    effort: "(default)", selection: "local-default", automaticExternalAllowed: false, legacyUnconfirmed: null }])) as ModelRoleSettings["roles"] };
}
