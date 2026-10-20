import type { JSX } from "react";
import { VAULT_ACCESS_COPY } from "../lib/vaultAccessCopy";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { Button } from "./ui";
import "../styles/vault-access.css";

/** Recovery stays visible even when the sidebar is collapsed. */
export default function VaultAccessNotice(): JSX.Element | null {
  const vault = useVaultStore((s) => s.currentVault);
  const error = useVaultStore((s) => s.error);
  const busy = useVaultStore((s) => s.isLoading);
  const restoreVault = useVaultStore((s) => s.restoreVault);
  const lang = useUIStore((s) => s.lang);
  const copy = VAULT_ACCESS_COPY[lang];
  if (vault || !error) return null;
  return (
    <section className="vault-access" aria-label={copy.title}>
      <div role="alert">
        <strong>{copy.title}</strong>
        <p>{copy.hint}</p>
      </div>
      <div className="vault-access__actions">
        <Button
          disabled={busy}
          onClick={() =>
            void restoreVault(
              new URLSearchParams(window.location.search).get("vault"),
            )
          }
        >
          {copy.retry}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            useUIStore.getState().setSettingsTab("account");
            useUIStore.getState().setRoute("settings");
          }}
        >
          {copy.choose}
        </Button>
      </div>
      <details>
        <summary>{copy.details}</summary>
        <p>{error}</p>
      </details>
    </section>
  );
}
