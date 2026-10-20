// On-disk card store for Feature 3 (study artifacts). Thin IO layer over the
// native origin-bound snapshot/CAS writer for mutations under `cards/<deck>.md`.
// Display parsing and FSRS math live in `cards.ts`/`fsrs.ts`; mutations preserve
// human document bytes through cardDeckPatch.ts.

import { ipc } from "./ipc";
import type { AgentVaultSession, FileNode, StudyDeckSnapshot } from "./ipc";
import { dueCards, type Card, type DeckCards } from "./cards";
import { appendDeckCards, patchDeckGrade, readDeckCards } from "./cardDeckPatch";
import { log } from "./log";
import { isCitation, isGrounded, parseSourceRef } from "./extractiveCards";

const CARDS_DIR = "cards";

export function cardsDir(vaultPath: string): string {
  return `${vaultPath}/${CARDS_DIR}`;
}

export function deckPath(vaultPath: string, deck: string): string {
  return `${cardsDir(vaultPath)}/${deck}.md`;
}

/** Deck name (filename minus .md) from a `cards/<deck>.md` path. */
export function deckNameFromPath(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.md$/i, "");
}

/** Sanitize a page stem / arbitrary title into a safe deck filename. */
export function deckSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/\.md$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "deck"
  );
}

/** All `cards/*.md` deck file paths present in the vault file tree. */
export function deckFiles(tree: FileNode[]): string[] {
  const cardsNode = tree.find(
    (n) => n.kind === "directory" && n.name === CARDS_DIR,
  );
  if (!cardsNode || cardsNode.kind !== "directory") return [];
  return cardsNode.children
    .filter((c) => c.kind === "file" && /\.md$/i.test(c.name))
    .map((c) => c.path);
}

export async function loadDeck(path: string): Promise<Card[]> {
  const file = await ipc.readFile(path);
  return readDeckCards(file.raw);
}

type DeckFailure = "origin" | "snapshot" | "read" | "write" | "partial" | "cleanup" | "existing";
export class StudyDeckError extends Error {
  constructor(public readonly code: DeckFailure) {
    super({
      origin: "Study vault opening changed",
      snapshot: "Invalid Study deck snapshot or receipt",
      read: "Study deck could not be read",
      write: "Study deck could not be saved",
      partial: "Study deck save is incomplete; inspect the retained file before retrying",
      cleanup: "Study deck snapshot cleanup could not be confirmed",
      existing: "Existing Study decks cannot be overwritten",
    }[code]);
    this.name = "StudyDeckError";
  }
}

const deckMutations = new Map<string, Promise<void>>();
const sameOrigin = (left: AgentVaultSession | undefined, right: AgentVaultSession): boolean =>
  left?.vaultPath === right.vaultPath && left.openingToken === right.openingToken;
const isRevision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const cloneCard = (card: Card): Card => ({ ...card, state: card.state === null ? null : { ...card.state } });

async function mutateDeck<T>(
  vaultPath: string,
  path: string,
  patch: (snapshot: StudyDeckSnapshot) => { content: string; result: T; write?: boolean },
): Promise<T> {
  let origin: AgentVaultSession;
  try { origin = Object.freeze({ ...await ipc.agentVaultSession() }); }
  catch { throw new StudyDeckError("origin"); }
  if (origin.vaultPath !== vaultPath || typeof origin.openingToken !== "string" || !origin.openingToken) throw new StudyDeckError("origin");
  const key = JSON.stringify([origin.vaultPath, origin.openingToken, path]);
  const previous = deckMutations.get(key);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  deckMutations.set(key, pending);
  if (previous) await previous;
  try {
    let snapshot: StudyDeckSnapshot;
    try { snapshot = await ipc.readStudyDeck(path, origin); }
    catch { throw new StudyDeckError("read"); }
    if (!snapshot?.context || typeof snapshot.context.snapshotId !== "string" || !snapshot.context.snapshotId ||
      snapshot.context.path !== path || !sameOrigin(snapshot.context.origin, origin)) throw new StudyDeckError("snapshot");
    const context = Object.freeze({ ...snapshot.context, origin });
    let outcome: { result: T } | { error: unknown };
    try {
      if (typeof snapshot.raw !== "string" || (snapshot.revision !== null && !isRevision(snapshot.revision)) ||
        (snapshot.revision === null && snapshot.raw !== "")) throw new StudyDeckError("snapshot");
      const change = patch(snapshot);
      if (change.write ?? change.content !== snapshot.raw) {
        let receipt;
        try { receipt = await ipc.writeStudyDeck(context, change.content); }
        catch { throw new StudyDeckError("write"); }
        if (!receipt || receipt.path !== path || !sameOrigin(receipt.origin, origin) ||
          !["persisted", "partial"].includes(receipt.state)) throw new StudyDeckError("snapshot");
        if (receipt.state === "partial") throw new StudyDeckError("partial");
        if (!isRevision(receipt.revision) || receipt.error !== null) throw new StudyDeckError("snapshot");
      }
      outcome = { result: change.result };
    } catch (error) {
      outcome = { error };
    }
    let cleanupFailed = false;
    try {
      const discarded = await ipc.discardStudyDeckSnapshot(context);
      if (typeof discarded !== "boolean") throw new StudyDeckError("cleanup");
    } catch {
      log.warn("study.deck_snapshot_cleanup_unconfirmed");
      cleanupFailed = true;
    }
    if ("error" in outcome) throw outcome.error;
    if (cleanupFailed) throw new StudyDeckError("cleanup");
    return outcome.result;
  } finally {
    release();
    if (deckMutations.get(key) === pending) deckMutations.delete(key);
  }
}

/** Create an absent deck through native absence CAS; never overwrite a file. */
export async function saveDeck(
  vaultPath: string,
  deck: string,
  cards: Card[],
): Promise<string> {
  const path = deckPath(vaultPath, deck);
  const incoming = cards.map(cloneCard);
  return mutateDeck(vaultPath, path, (snapshot) => {
    if (snapshot.revision !== null) throw new StudyDeckError("existing");
    return { content: appendDeckCards("", incoming).content, result: path, write: true };
  });
}

/** Write one graded card into its deck as the deck is on disk now. A review
 *  holds its decks for the whole session, so writing that copy back would
 *  drop the cards "Make cards" added meanwhile. A card deleted from disk
 *  stays deleted. */
export async function saveGrade(vaultPath: string, path: string, graded: Card, expectedCard?: Card): Promise<boolean> {
  const update = cloneCard(graded);
  const expected = expectedCard && cloneCard(expectedCard);
  return mutateDeck(vaultPath, path, (snapshot) => {
    const change = patchDeckGrade(snapshot.raw, update, expected);
    return { content: change.content, result: change.updated };
  });
}

/** Merge new cards into a deck, de-duping by the normalised front (case,
 *  spacing and markup ignored). Returns how many were actually added. */
export async function addCards(
  vaultPath: string,
  deck: string,
  incoming: Card[],
): Promise<{ path: string; added: number }> {
  const path = deckPath(vaultPath, deck);
  const additions = incoming.map(cloneCard);
  return mutateDeck(vaultPath, path, (snapshot) => {
    const change = appendDeckCards(snapshot.raw, additions);
    return { content: change.content, result: { path, added: change.added } };
  });
}

export interface DeckSummary {
  name: string;
  path: string;
  total: number;
  due: number;
  /** Cards with no source, or a back that no note behind the source
   *  contains (extractiveCards.isGrounded) — spec 2026-09-29 Part 2. */
  ungrounded: number;
}

/** `read(key)` once per key, a failure read as `fallback`. */
function once<T>(read: (key: string) => Promise<T>, fallback: T, failOnReadError: boolean): (key: string) => Promise<T> {
  const seen = new Map<string, Promise<T>>();
  return (key) => {
    let got = seen.get(key);
    if (!got) {
      got = read(key).catch((error: unknown) => {
        if (failOnReadError) throw error;
        return fallback;
      });
      seen.set(key, got);
    }
    return got;
  };
}

/** Load every deck in the tree and summarize total/due/ungrounded counts for
 *  `today`. `readNote` returns a source note's text by stem, null when there
 *  is none; `readCiting` the texts of the notes citing a `[^src-*]` source
 *  (spec Part 2: the back must occur in a vault note). Each is read once per
 *  call. `failOnReadError` lets a user-facing scan distinguish failed reads
 *  from missing sources or an actually empty collection. */
export async function summarizeDecks(
  tree: FileNode[],
  today: string,
  readNote: (stem: string) => Promise<string | null> = () => Promise.resolve(null),
  readCiting: (sourceRef: string) => Promise<string[]> = () => Promise.resolve([]),
  failOnReadError = false,
): Promise<DeckSummary[]> {
  const noteOf = once(readNote, null, failOnReadError);
  const citingOf = once(readCiting, [], failOnReadError);
  const paths = deckFiles(tree);
  const out: DeckSummary[] = [];
  for (const path of paths) {
    try {
      const cards = await loadDeck(path);
      let ungrounded = 0;
      for (const c of cards) {
        const ref = parseSourceRef(c.sourceRef);
        const notes = ref
          ? [await noteOf(ref.stem)]
          : isCitation(c.sourceRef)
            ? await citingOf(c.sourceRef.trim())
            : [];
        if (!notes.some((n) => isGrounded(c, n))) ungrounded++;
      }
      out.push({
        name: deckNameFromPath(path),
        path,
        total: cards.length,
        due: dueCards(cards, today).length,
        ungrounded,
      });
    } catch (error) {
      if (failOnReadError) throw error;
      /* skip unreadable deck */
    }
  }
  return out;
}

/** Whether a deck counts toward Study, the sidebar badge and Home: not when
 *  every one of its cards is ungrounded (a model-made deck with nothing of
 *  the vault in it). */
function isCounted(d: DeckSummary): boolean {
  return !(d.total > 0 && d.ungrounded >= d.total);
}

/** The due count a deck contributes to Study, the sidebar badge and Home. */
export function countedDue(d: DeckSummary): number {
  return isCounted(d) ? d.due : 0;
}

/** Every deck that counts, loaded, for today's review queue (UX S34): its
 *  size is the due number Home shows. Decks with nothing due today load too,
 *  since they hold the next review. A deck that cannot be read is skipped,
 *  as summarizeDecks skips it, so the two counts still agree. */
export async function loadCountedDecks(decks: DeckSummary[]): Promise<DeckCards[]> {
  const out: DeckCards[] = [];
  for (const d of decks.filter(isCounted)) {
    try {
      out.push({ path: d.path, cards: await loadDeck(d.path) });
    } catch {
      /* gone since the last refresh: summarizeDecks would skip it too */
    }
  }
  return out;
}

/** Move a deck into `cards/archive/` (created on demand) — out of every list
 *  and count, and restorable by moving it back. Resolves to the new path. */
export async function archiveDeck(vaultPath: string, path: string): Promise<string> {
  try {
    await ipc.createFolder(cardsDir(vaultPath), "archive");
  } catch {
    /* already exists */
  }
  return ipc.movePath(path, `${cardsDir(vaultPath)}/archive`);
}
