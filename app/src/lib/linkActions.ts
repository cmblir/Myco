// One action owner for the Overview, reader and native agenda. Disk appends
// are conditional; an open reader receives the append through its live draft.
import { ipc } from "./ipc";
import { STRINGS } from "./i18n";
import { notice } from "./notice";
import { acceptAll, suggestionRelativePath, type LinkSuggestion, type LinkSuggestionIO } from "./linkSuggestions";
import { pendingDrafts, useVaultStore } from "../stores/vaultStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useNoticeStore } from "../stores/noticeStore";
import { useUIStore } from "../stores/uiStore";

const drafts = new Map<string, LinkSuggestionIO>();

/** Register the reader's existing draft writer, without replacing autosave. */
export function registerLinkDraft(path: string, io: LinkSuggestionIO): () => void {
  drafts.set(path, io);
  return () => { if (drafts.get(path) === io) drafts.delete(path); };
}

interface LinkActionOptions {
  io?: LinkSuggestionIO;
  bulk?: boolean;
  /** Keep the existing single-row exit animation before removing the pair. */
  onAccepted?: () => Promise<void>;
  successTitle?: string;
}

/** Run a user-approved set once, with visible partial failures and retry. */
export async function applyLinkSuggestions(
  suggestions: LinkSuggestion[],
  options: LinkActionOptions = {},
): Promise<boolean> {
  const state = useLinkSuggestStore.getState();
  if (!suggestions.length || state.busy || (options.bulk && useNoticeStore.getState().progress)) return false;
  const root = useVaultStore.getState().currentVault?.path;
  const token = useVaultStore.getState().vaultToken;
  const isCurrent = (): boolean => {
    const vault = useVaultStore.getState();
    return vault.currentVault?.path === root && vault.vaultToken === token && !vault.isOpeningVault;
  };
  if (!root || !isCurrent() || !state.beginAction()) return false;
  const t = STRINGS[useUIStore.getState().lang];
  const label = t.ls_linking;
  const total = suggestions.length;
  const progress = useNoticeStore.getState();
  const guard = (path: string): void => {
    if (!isCurrent()) throw new Error("Vault changed; remaining links were not written");
    suggestionRelativePath(path, root);
  };
  // Select the draft for each document, since a bulk set can include the
  // currently open note. A draft unmounted during a read must not be reused.
  const readers = new Map<string, LinkSuggestionIO | undefined>();
  const io: LinkSuggestionIO = {
    vaultRoot: root,
    transformFile(path, transform) {
      guard(path);
      return (options.io ?? drafts.get(path))?.transformFile?.(path, transform);
    },
    async readFile(path) {
      guard(path);
      const draft = options.io ?? drafts.get(path);
      readers.set(path, draft);
      if (!draft && pendingDrafts.has(path)) throw new Error("This note has unsaved edits; save it before linking");
      const file = await (draft ?? ipc).readFile(path);
      guard(path);
      return file;
    },
    writeFile: ipc.writeFile,
    async writeFileIfUnchanged(path, content, expected) {
      guard(path);
      const draft = readers.get(path);
      if (draft) {
        if (!options.io && drafts.get(path) !== draft) throw new Error("The open note changed; retry its links");
        return draft.writeFile(path, content);
      }
      if (drafts.has(path) || pendingDrafts.has(path)) throw new Error("This note has unsaved edits; save it before linking");
      return ipc.writeFileIfUnchanged(path, content, expected);
    },
  };
  let ok = false;
  let ownedProgress = progress.progress;
  const reportProgress = (done: number): void => {
    if (!isCurrent()) return;
    progress.setProgress({ key: "links", label, done, total });
    ownedProgress = useNoticeStore.getState().progress;
  };
  if (options.bulk) reportProgress(0);
  try {
    for (const s of suggestions) { guard(s.source); guard(s.target); }
    const result = await acceptAll(suggestions, io, options.bulk
      ? reportProgress
      : undefined);
    let decisionsSaved = true;
    if (result.accepted.length && isCurrent()) {
      await options.onAccepted?.();
      guard(suggestions[0].source);
      decisionsSaved = useLinkSuggestStore.getState().dismiss(result.accepted.map((s) => s.key));
      await useVaultStore.getState().refreshLinkGraph();
    }
    if (result.error) {
      notice.warn(t.ls_toast_failed, {
        sub: result.error,
        action: { label: t.ls_toast_retry, run: () => {
          if (isCurrent()) void applyLinkSuggestions(result.remaining, { ...options, onAccepted: undefined });
        } },
      });
      return false;
    }
    if (!decisionsSaved || !isCurrent()) return false;
    ok = true;
    if (options.bulk || options.successTitle) notice.ok(
      options.successTitle ?? t.ls_toast_linked.replace("{n}", String(result.accepted.length)),
      { sub: t.ls_toast_linked_sub, icon: "link" },
    );
    return true;
  } catch (error) {
    notice.warn(t.ls_toast_failed, { sub: String(error) });
    return false;
  } finally {
    if (options.bulk && useNoticeStore.getState().progress === ownedProgress) progress.endProgress(ok);
    if (isCurrent()) useLinkSuggestStore.getState().endAction();
  }
}
