// The one place the app volunteers that an update exists. It never interrupts:
// no modal, no relaunch, and a dismiss button that keeps it quiet for the rest
// of the session. The update itself lands on the next launch.

import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { useUpdateStore, updateBanner } from "../stores/updateStore";

export default function UpdateBanner({ t }: { t: Strings }): JSX.Element | null {
  // Primitive selectors, then derive: a selector returning a fresh object would
  // hand useSyncExternalStore a new snapshot on every store notification.
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.version);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const restartNow = useUpdateStore((s) => s.restartNow);
  const banner = updateBanner({ status, version, dismissed });

  if (banner.kind === "hidden") return null;

  const downloading = banner.kind === "downloading";
  return (
    // Polite: an update is never worth cutting into what a screen reader is
    // already saying.
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner__text">
        {downloading
          ? (t.up_downloading ?? "Downloading myco {v}…").replace(
              "{v}",
              banner.version,
            )
          : (t.up_ready ?? "myco {v} is ready").replace("{v}", banner.version)}
      </span>
      {downloading ? null : (
        <>
          {/* Passive wording stays as the fallback -- the button below is a
              convenience, restarting is still the user's own choice. */}
          <span className="update-banner__hint">
            {t.up_restart ?? "Restart myco to apply"}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void restartNow()}
          >
            {t.up_restart_btn ?? "Restart now"}
          </button>
        </>
      )}
      <button
        type="button"
        className="update-banner__close"
        onClick={dismiss}
        aria-label={t.up_dismiss ?? "Dismiss"}
      >
        ×
      </button>
    </div>
  );
}
