// On-disk card store for Feature 3 (study artifacts). Thin IO layer over the
// existing vault IPC (`read_file`/`write_file`/`create_folder`) that reads and
// writes decks as plain markdown under `cards/<deck>.md`. Parsing/serialization
// and FSRS math live in `cards.ts`/`fsrs.ts`; this module only touches disk.

import { ipc } from "./ipc";
import type { FileNode } from "./ipc";
import { parseDeck, serializeDeck, dueCards, type Card } from "./cards";

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
  return parseDeck(file.raw);
}

/** Overwrite a deck file with the given cards, creating `cards/` if needed. */
export async function saveDeck(
  vaultPath: string,
  deck: string,
  cards: Card[],
): Promise<string> {
  try {
    await ipc.createFolder(vaultPath, CARDS_DIR);
  } catch {
    /* already exists */
  }
  const path = deckPath(vaultPath, deck);
  await ipc.writeFile(path, serializeDeck(cards));
  return path;
}

/** Merge new cards into a deck, de-duping by front text. Returns how many were
 *  actually added (duplicates of existing fronts are dropped). */
export async function addCards(
  vaultPath: string,
  deck: string,
  incoming: Card[],
): Promise<{ path: string; added: number }> {
  const path = deckPath(vaultPath, deck);
  let existing: Card[] = [];
  try {
    existing = parseDeck((await ipc.readFile(path)).raw);
  } catch {
    /* new deck */
  }
  const seen = new Set(existing.map((c) => c.front.trim().toLowerCase()));
  const merged = [...existing];
  let added = 0;
  for (const c of incoming) {
    const key = c.front.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
    added++;
  }
  const saved = await saveDeck(vaultPath, deck, merged);
  return { path: saved, added };
}

export interface DeckSummary {
  name: string;
  path: string;
  total: number;
  due: number;
}

/** Load every deck in the tree and summarize total/due counts for `today`. */
export async function summarizeDecks(
  tree: FileNode[],
  today: string,
): Promise<DeckSummary[]> {
  const paths = deckFiles(tree);
  const out: DeckSummary[] = [];
  for (const path of paths) {
    try {
      const cards = await loadDeck(path);
      out.push({
        name: deckNameFromPath(path),
        path,
        total: cards.length,
        due: dueCards(cards, today).length,
      });
    } catch {
      /* skip unreadable deck */
    }
  }
  return out;
}
