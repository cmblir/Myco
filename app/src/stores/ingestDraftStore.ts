import { create } from "zustand";
import type { WorkflowStatus } from "../lib/workflowOutcome";

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface IngestDraft {
  title: string;
  body: string;
  revision: string;
  storageError: "load" | "save" | "clear" | null;
}

interface IngestDraftState {
  drafts: Record<string, IngestDraft>;
  load(root: string): void;
  edit(root: string, patch: Partial<Pick<IngestDraft, "title" | "body">>): void;
  discard(root: string): void;
  complete(root: string, revision: string, status: WorkflowStatus | null): void;
  retry(root: string): void;
}

const emptyDraft = (): IngestDraft => ({
  title: "", body: "", revision: crypto.randomUUID(), storageError: null,
});
const keyFor = (root: string): string => `myco.ingestDraft.v1:${encodeURIComponent(root)}`;

/** Durable form state belongs to the device and vault, not a mounted page.
 * Failed persistence retains the input in memory and exposes a scoped retry. */
export function createIngestDraftStore(storage: () => DraftStorage = () => localStorage) {
  return create<IngestDraftState>((set, get) => {
    const publish = (root: string, draft: IngestDraft): void =>
      set((state) => ({ drafts: { ...state.drafts, [root]: draft } }));
    const read = (root: string): IngestDraft => {
      const blank = emptyDraft();
      try {
        const raw = storage().getItem(keyFor(root));
        if (raw === null) return blank;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" ||
          !("version" in parsed) || parsed.version !== 1 ||
          !("root" in parsed) || parsed.root !== root ||
          !("title" in parsed) || typeof parsed.title !== "string" ||
          !("body" in parsed) || typeof parsed.body !== "string" ||
          !("revision" in parsed) || typeof parsed.revision !== "string" || !parsed.revision) {
          throw new Error("Invalid Ingest draft record");
        }
        return { title: parsed.title, body: parsed.body, revision: parsed.revision, storageError: null };
      } catch {
        // Do not expose draft contents or storage exceptions in application logs.
        return { ...blank, storageError: "load" };
      }
    };
    const save = (root: string, draft: IngestDraft): void => {
      let storageError: IngestDraft["storageError"] = null;
      try {
        storage().setItem(keyFor(root), JSON.stringify({ version: 1, root,
          title: draft.title, body: draft.body, revision: draft.revision }));
      } catch {
        storageError = "save";
      }
      publish(root, { ...draft, storageError });
    };
    return {
      drafts: {},
      load(root) {
        if (root && !get().drafts[root]) publish(root, read(root));
      },
      edit(root, patch) {
        if (!root) return;
        get().load(root);
        const previous = get().drafts[root];
        if ((patch.title === undefined || patch.title === previous.title) &&
          (patch.body === undefined || patch.body === previous.body)) return;
        save(root, { ...previous, ...patch, revision: crypto.randomUUID() });
      },
      discard(root) {
        if (!root) return;
        get().load(root);
        try {
          storage().removeItem(keyFor(root));
          publish(root, emptyDraft());
        } catch {
          publish(root, { ...get().drafts[root], storageError: "clear" });
        }
      },
      complete(root, revision, status) {
        if (status === "success" && get().drafts[root]?.revision === revision) get().discard(root);
      },
      retry(root) {
        const draft = get().drafts[root];
        if (draft?.storageError === "load") publish(root, read(root));
        else if (draft?.storageError === "clear") get().discard(root);
        else if (draft?.storageError === "save") save(root, draft);
      },
    };
  });
}

export const useIngestDraftStore = createIngestDraftStore();
