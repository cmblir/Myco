// What the roam window hears from src-tauri/src/roam.rs: where myco roams
// (null while it is in the notch), and the pointer while it is out. The
// pointer is re-dispatched as the pointermove the mascot already listens to,
// as notchDriver does with the notch's feed, so both have one input path.
// And from the notch (lib/roamTrigger), the cue: the work myco is out for.

import { useEffect, useState } from "react";
import { ipc } from "./ipc";
import type { RoamPlace } from "./ipc";
import { ROAM_CUE_EVENT, ROAM_HELLO_EVENT, ROAM_VISIBILITY_EVENT } from "./roam";
import type { RoamCue } from "./roam";

export function useRoamPlace(enabled: boolean): RoamPlace | null {
  const [place, setPlace] = useState<RoamPlace | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    // The event outranks the first pull: it is newer by definition.
    let heard = false;
    let stops: (() => void)[] = [];
    // This webview can load after the event that sent myco out.
    void ipc.roamPlace().then(
      (p) => {
        if (!gone && !heard) setPlace(p);
      },
      () => {
        /* plain-browser dev: no Tauri backend */
      },
    );
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        Promise.all([
          listen<RoamPlace | null>(ROAM_VISIBILITY_EVENT, ({ payload }) => {
            heard = true;
            setPlace(payload);
          }),
          listen<[number, number]>("roam-cursor", ({ payload: [x, y] }) => {
            window.dispatchEvent(
              new PointerEvent("pointermove", { clientX: x, clientY: y }),
            );
          }),
        ]),
      )
      .then((us) => {
        if (gone) us.forEach((u) => u());
        else stops = us;
      })
      .catch((err: unknown) => console.error("roam: listen failed:", err));
    return () => {
      gone = true;
      stops.forEach((u) => u());
    };
  }, [enabled]);
  return enabled ? place : null;
}

/** The notch's cue for the roam myco is out on, or null before one came.
 *  Dropped once myco is back (`out` false), so the next roam never starts on
 *  the last one's outcome. Asks the notch for it once listening, since this
 *  webview can load after it went out. */
export function useRoamCue(enabled: boolean, out: boolean): RoamCue | null {
  const [cue, setCue] = useState<RoamCue | null>(null);
  useEffect(() => {
    if (!out) setCue(null);
  }, [out]);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    let stop: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(async ({ emit, listen }) => {
        const u = await listen<RoamCue>(ROAM_CUE_EVENT, ({ payload }) => setCue(payload));
        await emit(ROAM_HELLO_EVENT);
        return u;
      })
      .then((u) => {
        if (gone) u();
        else stop = u;
      })
      .catch((err: unknown) => console.error("roam: cue listen failed:", err));
    return () => {
      gone = true;
      stop?.();
    };
  }, [enabled]);
  return enabled ? cue : null;
}
