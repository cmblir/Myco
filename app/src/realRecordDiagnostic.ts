import { createDiagnosticAnswerContract } from "./lib/diagnosticAnswerContract";
import { registerModelContextBudget, type ModelContextBudget } from "./lib/modelContextBudget";
import { invoke } from "@tauri-apps/api/core";
import { ipc } from "./lib/ipc";
import { useVaultStore } from "./stores/vaultStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useQueryStore, askCopy } from "./stores/queryStore";
import { STRINGS } from "./lib/i18n";
// The isolated diagnostic vault, named by the run (never a path in source).
const root: string = import.meta.env.VITE_MYCO_REAL_DIAG_VAULT ?? "";
const capture = async (kind: string, data: unknown) => {
  const r = await fetch("/__myco_diag", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, data }),
  });
  if (!r.ok) throw new Error("capture failed");
};
export async function runRealRecordDiagnostic() {
  if (new URLSearchParams(location.search).has("window")) return;
  try {
    if (!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__)
      throw new Error("Native Tauri required; browser mock prohibited");
    if (!root) throw new Error("VITE_MYCO_REAL_DIAG_VAULT must name the isolated diagnostic vault");
    await capture("start", {
      href: location.href,
      root,
      native: true,
      model: "myco-r10-candidate2-final1200-diagnostic",
      transport: "genuine saved R10 candidate2 final1200 MLX generation; diagnostic app transport",
      modelQualityEvaluation: true,
      nativeGgufQualification: false,
    });
    const adapter: ModelContextBudget = {
      contextTokens: 4096, outputTokens: 768,
      async countMessages(messages) {
        const response = await fetch("/__myco_tokenize", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({model: "myco-r10-candidate2-final1200-diagnostic", messages}),
        });
        if (!response.ok) throw new Error("Exact local tokenization failed");
        const result = await response.json();
        if (result.model !== "myco-r10-candidate2-final1200-diagnostic" || result.contextTokens !== 4096 || result.outputTokens !== 768)
          throw new Error("Tokenizer runtime contract mismatch");
        return result.promptTokens;
      },
      record: audit => capture("context-packing", audit),
    };
    adapter.prepareInput = createDiagnosticAnswerContract(adapter, capture);
    registerModelContextBudget("ollama", "myco-r10-candidate2-final1200-diagnostic", adapter);
    // Wrappers record actual input/output, then return original results unchanged.
    for (const name of [
      "agentVaultSession",
      "captureModelRole",
      "getSettings",
      "getDistillConfig",
      "classifyIntent",
      "semanticSearch",
      "embeddingsStatus",
      "readVaultContext",
      "chatComplete",
    ] as const) {
      const original = ipc[name] as (...args: unknown[]) => Promise<unknown>;
      (ipc as unknown as Record<string, unknown>)[name] = async (
        ...args: unknown[]
      ) => {
        const t = performance.now();
        await capture("ipc-request", { name, args });
        try {
          const result = await original(...args);
          await capture("ipc-result", {
            name,
            result,
            elapsedMs: performance.now() - t,
          });
          return result;
        } catch (e) {
          await capture("ipc-error", {
            name,
            error: String(e),
            elapsedMs: performance.now() - t,
          });
          throw e;
        }
      };
    }
    // Wait for the normal bootstrap to settle before opening the isolated vault.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await useSettingsStore.getState().load();
    await useVaultStore.getState().openVault(root);
    if (
      useVaultStore.getState().currentVault?.path !== root ||
      useVaultStore.getState().error
    )
      throw new Error(
        "isolated vault opening failed: " + useVaultStore.getState().error,
      );
    await useSettingsStore.getState().setProviderConnected("ollama", true);
    await useSettingsStore
      .getState()
      .selectRole({
        role: "ask",
        providerId: "ollama",
        modelId: "myco-r10-candidate2-final1200-diagnostic",
        effort: "",
      });
    await capture("configured", {
      role: useSettingsStore.getState().settings?.model_roles?.roles.ask,
      vault: useVaultStore.getState().currentVault,
    });
    // Prepare all native indexable documents with the app BM25/chunk implementation; dense indexing is explicitly absent.
    await capture("index-start", {});
    try {
      const result = await invoke("diagnostic_reindex_lexical");
      await capture("index-complete", result);
    } catch (e) {
      if (String(e).includes("lexical index already exists"))
        await capture("index-reused", {
          reason: "Unchanged all-corpus BM25 index from v2; no gold filtering",
        });
      else throw e;
    }
    // The frozen cases are the maintainer's real questions, so they live in a
    // local file named by MYCO_REAL_DIAG_CASES, which the dev server serves.
    const listed = await fetch("/__myco_diag_cases");
    if (!listed.ok) throw new Error("MYCO_REAL_DIAG_CASES must name the local diagnostic case file");
    const cases: unknown = await listed.json();
    if (!Array.isArray(cases) || !cases.every((c): c is { id: string; q: string; context: string } =>
      typeof c?.id === "string" && typeof c?.q === "string" && typeof c?.context === "string"))
      throw new Error("The diagnostic case file must be a list of {id, q, context}");
    const requestedCase = import.meta.env.VITE_MYCO_REAL_DIAG_CASE;
    if (requestedCase) throw new Error("R10 comparison requires all eight frozen cases; unset VITE_MYCO_REAL_DIAG_CASE");
    const requestedIds = requestedCase ? requestedCase.split(",") : null;
    const scheduled = requestedIds ? cases.filter(c => requestedIds.includes(c.id)) : cases;
    if (!scheduled.length || (requestedIds && scheduled.length !== requestedIds.length))
      throw new Error("Unknown or repeated diagnostic case selection");
    await capture("schedule", {caseIds: scheduled.map(c => c.id), fullSuite: !requestedCase});
    for (const c of scheduled) {
      if (c.id !== "recall") useQueryStore.getState().clear();
      const start = performance.now();
      const input = c.context ? c.context + "\n" + c.q : c.q;
      await capture("case-start", {
        ...c,
        input,
        scope: "all",
        pathFilter: null,
      });
      try {
        await useQueryStore
          .getState()
          .ask(input, "ko", askCopy(STRINGS.ko), { scope: "all" });
        const turn = useQueryStore.getState().turns.at(-1);
        await capture("case-result", {
          id: c.id,
          turn,
          elapsedMs: performance.now() - start,
        });
        if (c.id === "ambiguous_fresh_recall" || turn?.abstained) {
          await new Promise(resolve => setTimeout(resolve, 300));
          await useQueryStore.getState().loadHistory();
          await capture("abstention-history-reloaded", {
            record: useQueryStore.getState().history.at(-1), historyError: useQueryStore.getState().historyError,
          });
        }
        const citations = [
          ...(turn?.a ?? "").matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g),
        ].map((m) => m[1]);
        for (const target of [...new Set(citations)]) {
          if (target.includes("..") || target.startsWith("/")) {
            await capture("citation-rejected", { id: c.id, target });
            continue;
          }
          const path =
            root +
            "/" +
            target.replace(/#.*$/, "") +
            (target.replace(/#.*$/, "").endsWith(".md") ? "" : ".md");
          const openError = await useVaultStore.getState().openFile(path);
          await capture("citation-open", {
            id: c.id,
            target,
            error: openError ?? null,
            activeFile: useVaultStore.getState().activeFile,
          });
        }
      } catch (e) {
        await capture("case-error", {
          id: c.id,
          error: String(e),
          elapsedMs: performance.now() - start,
        });
      }
    }
    await capture("finished", {
      cases: scheduled.length,
      turns: useQueryStore.getState().turns,
    });
  } catch (e) {
    await capture("fatal", {
      error: String(e),
      stack: e instanceof Error ? e.stack : null,
    });
  }
}
