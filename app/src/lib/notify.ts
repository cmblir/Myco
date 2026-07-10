// Native notifications (Feature 7, opt-in). Thin wrapper over the Tauri
// notification plugin: request permission on first use, then post. Fully
// best-effort — any failure (permission denied, plugin absent in a dev browser)
// is swallowed so a digest run is never blocked by notification issues.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export async function notify(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications unavailable (dev browser / denied) — non-fatal */
  }
}
