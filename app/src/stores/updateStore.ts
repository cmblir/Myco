// In-app updates. Two entry points, one state machine: a silent pass when the
// app starts and the "Check for updates" button in Settings -> About.
//
// Policy, and the reason this is a store rather than local component state: a
// found update is downloaded and staged in the BACKGROUND, and takes effect the
// next time the user launches myco on their own. We never relaunch for them, so
// the "ready" state has to outlive whatever page they navigate to.

import { create } from "zustand";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  /** Never checked in this session. */
  | "idle"
  /** No signing pubkey in this build -> nothing to verify against, so we don't ask. */
  | "unconfigured"
  /** The release channel has no artifact for this OS/arch yet. */
  | "unavailable"
  | "checking"
  /** Checked, already newest. */
  | "current"
  /** A newer version was found and is coming down. */
  | "downloading"
  /** Downloaded and staged; applies on the next launch. */
  | "ready"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** The NEW version when one was found, else null. */
  version: string | null;
  error: string | null;
  /** The banner was dismissed for this session. Never blocks Settings. */
  dismissed: boolean;
  checkForUpdates: () => Promise<void>;
  dismiss: () => void;
  /** Relaunches the app to apply a staged update. Only ever called by the
   * user clicking "Restart now" — never automatic. */
  restartNow: () => Promise<void>;
}

/** What the app-wide banner should show, derived from the whole state. */
export type UpdateBanner =
  | { kind: "hidden" }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string };

export function updateBanner(
  s: Pick<UpdateState, "status" | "version" | "dismissed">,
): UpdateBanner {
  if (s.dismissed || !s.version) return { kind: "hidden" };
  if (s.status === "downloading")
    return { kind: "downloading", version: s.version };
  if (s.status === "ready") return { kind: "ready", version: s.version };
  // idle / checking / current / error / unconfigured / unavailable all belong in
  // Settings, not in a banner across the whole app.
  return { kind: "hidden" };
}

// The updater reports a missing platform entry as a plain error, which would
// otherwise reach the user as `the platform \`windows-x86_64\` was not found in
// the response \`platforms\` object`. Both variants of that error (single target
// and fallback list) share this phrase.
// ponytail: substring match on the plugin's error text — the plugin has no typed
// error on the JS side. Drop it once latest.json covers every platform we ship.
const NO_PLATFORM_ENTRY = "found in the response `platforms` object";

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Update check failed";
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: "idle",
  version: null,
  error: null,
  dismissed: false,

  checkForUpdates: async () => {
    // No pubkey baked in => any download would fail signature verification at
    // the last step. Say so instead of failing late.
    if (!__UPDATER_CONFIGURED__) {
      set({ status: "unconfigured", version: null, error: null });
      return;
    }
    const status = get().status;
    if (status === "checking" || status === "downloading") return;

    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (!update) {
        set({ status: "current", version: null });
        return;
      }
      // Show the banner while it downloads, then leave it standing on "ready".
      // A previous dismissal is for a previous version, so it resets here.
      set({ status: "downloading", version: update.version, dismissed: false });
      // Stages the new bundle next to the running one on macOS; the running
      // process is untouched. NOTE: the Windows NSIS updater RESTARTS the app
      // from here, so before latest.json gains a windows entry this must split
      // into download() now / install() on quit.
      await update.downloadAndInstall();
      set({ status: "ready" });
    } catch (e) {
      const text = message(e);
      if (text.includes(NO_PLATFORM_ENTRY)) {
        set({ status: "unavailable", version: null, error: null });
        return;
      }
      set({ status: "error", error: text });
    }
  },

  dismiss: () => set({ dismissed: true }),

  restartNow: () => relaunch(),
}));
