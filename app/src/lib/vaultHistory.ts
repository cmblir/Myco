// Pure decision logic for the vault-history opt-in banner (Q4 item 1).
export const DISMISS_KEY = "myco.vaultHistory.dismissed";

export interface HistoryOfferInput {
  gitPresent: boolean;
  enabled: boolean;
  dismissed: boolean;
}

export function shouldOfferHistory(i: HistoryOfferInput): boolean {
  return !i.enabled && !i.dismissed;
}

export function loadDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode: banner reappears next launch, harmless */
  }
}
