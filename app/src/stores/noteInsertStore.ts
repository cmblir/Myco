// Insert into the open note at its caret, for surfaces outside the editor:
// the Connections rail, resurfaced notes, an Ask answer in the split pane.
// The reader sets `insert` while a writable note is open (never one under
// raw/) and clears it when the note closes; null = nowhere to insert, so
// those surfaces show no insert button.

import { create } from "zustand";

/** `block`: a quote as a block of its own; otherwise a link at the caret. */
export type NoteInsert = (text: string, block: boolean) => void;

export const useNoteInsertStore = create<{ insert: NoteInsert | null }>(() => ({
  insert: null,
}));
