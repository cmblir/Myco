// One-line live transcript under the waveform (notch + spotlight). Confirmed
// words bright, whisper's still-churning tail dim (lib/liveCaption). When the
// line outgrows its box it slides left so the newest words stay in view, with
// a fade on the clipped edge. `noInputText` replaces the transcript with the
// amber "no sound" warning while the mic is silent.

import { useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { CaptionState } from "../lib/liveCaption";

export default function LiveCaption({
  caption,
  noInputText,
}: {
  caption: CaptionState;
  noInputText?: string | null;
}): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const text = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    const over = (text.current?.scrollWidth ?? 0) - (box.current?.clientWidth ?? 0);
    // Never slide the warning: it is one fixed sentence, `.live-caption-warn`
    // kills the fade, and shifting it left would clip the HEAD of the one
    // message that has to be readable — with no fade to say so.
    setShift(noInputText ? 0 : Math.max(0, over));
  }, [caption, noInputText]);

  return (
    <div
      ref={box}
      className={`live-caption${shift > 0 ? " is-overflow" : ""}${noInputText ? " live-caption-warn" : ""}`}
      role="status"
    >
      <span
        ref={text}
        className="live-caption-text"
        style={shift > 0 ? { transform: `translateX(-${shift}px)` } : undefined}
      >
        {noInputText ?? (
          <>
            {caption.confirmed.join(" ")}
            {caption.confirmed.length > 0 && caption.interim.length > 0 ? " " : ""}
            <span className="live-caption-dim">{caption.interim.join(" ")}</span>
          </>
        )}
      </span>
    </div>
  );
}
