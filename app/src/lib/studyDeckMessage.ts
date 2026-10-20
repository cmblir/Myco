import { StudyDeckError } from "./cardStore";
import type { Strings } from "./i18n";

/** Display storage outcomes without revealing native or source error details. */
export function studyDeckMessage(error: unknown, t: Strings): string {
  if (!(error instanceof StudyDeckError)) return t.st_deck_save_failed;
  switch (error.code) {
    case "partial": return t.st_deck_partial;
    case "read": return t.st_deck_read_failed;
    case "origin":
    case "snapshot":
    case "existing": return t.st_deck_changed;
    case "write":
    case "cleanup": return t.st_deck_save_failed;
  }
}
