// Audio Overview panel (Feature 5). Renders the current overview: a compact
// player (play/pause/stop) over the browser-TTS dialogue and the speaker-tagged
// transcript with clickable turns (seek) and page citations. Global (one
// overview at a time via audioStore); shown wherever an overview is generated.

import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useAudioStore } from "../stores/audioStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

export default function AudioOverviewPanel({ t }: { t: Strings }): JSX.Element | null {
  const generating = useAudioStore((s) => s.generating);
  const script = useAudioStore((s) => s.script);
  const error = useAudioStore((s) => s.error);
  const playing = useAudioStore((s) => s.playing);
  const currentTurn = useAudioStore((s) => s.currentTurn);
  const transcriptPath = useAudioStore((s) => s.transcriptPath);
  const canPlay = useAudioStore((s) => s.ttsAvailable);
  const play = useAudioStore((s) => s.play);
  const pause = useAudioStore((s) => s.pause);
  const stop = useAudioStore((s) => s.stop);
  const seek = useAudioStore((s) => s.seek);
  const reset = useAudioStore((s) => s.reset);
  const setRoute = useUIStore((s) => s.setRoute);
  const resolveWikilink = useVaultStore((s) => s.resolveWikilink);

  if (!generating && !script && !error) return null;

  const openCite = (cite: string): void => {
    const stem = cite.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
    const abs = resolveWikilink(stem);
    if (abs) setRoute(`page:${abs}`);
  };

  return (
    <section className="audio-panel card" style={{ marginTop: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <Icon name="spark" size={16} />
          <b>{t.au_title ?? "Audio overview"}</b>
        </div>
        {script || error ? (
          <button className="btn btn-ghost" onClick={reset} aria-label={t.au_close ?? "Close"}>
            <Icon name="x" size={13} />
          </button>
        ) : null}
      </div>

      {generating ? (
        <div className="muted au-generating" style={{ fontSize: 13 }}>
          <span className="agent-spinner">●</span> {t.au_generating ?? "Writing the dialogue…"}
        </div>
      ) : null}

      {error ? <p style={{ color: "#dc2626", fontSize: 13 }}>{error}</p> : null}

      {script ? (
        <>
          <div className="au-controls row" style={{ gap: 8, marginBottom: 10 }}>
            {playing ? (
              <button className="btn" onClick={pause}>
                <Icon name="x" size={12} /> {t.au_pause ?? "Pause"}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => play()}
                disabled={!canPlay}
                title={canPlay ? undefined : (t.au_no_tts ?? "Speech synthesis unavailable")}
              >
                <Icon name="spark" size={12} /> {t.au_play ?? "Play"}
              </button>
            )}
            <button className="btn" onClick={stop} disabled={!playing && currentTurn < 0}>
              {t.au_stop ?? "Stop"}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {(t.au_turns ?? "{n} turns").replace("{n}", String(script.turns.length))}
            </span>
            {transcriptPath ? (
              <button
                className="btn btn-ghost"
                style={{ marginLeft: "auto", fontSize: 12.5 }}
                onClick={() => setRoute(`page:${transcriptPath}`)}
              >
                {t.au_open_transcript ?? "Open transcript"} →
              </button>
            ) : null}
          </div>
          {!canPlay ? (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              <Icon name="info" size={12} /> {t.au_no_tts ?? "Speech synthesis unavailable — transcript only."}
            </div>
          ) : null}

          <ol className="au-transcript">
            {script.turns.map((turn, i) => (
              <li
                key={i}
                className={"au-turn" + (i === currentTurn ? " active" : "")}
              >
                <button
                  className="au-turn-play"
                  onClick={() => seek(i)}
                  disabled={!canPlay}
                  aria-label={t.au_play_from ?? "Play from here"}
                >
                  <span className={"au-speaker au-speaker-" + turn.speaker}>
                    {turn.speaker === "A" ? (t.au_host ?? "Host") : (t.au_guest ?? "Guest")}
                  </span>
                </button>
                <span className="au-turn-text">
                  {turn.text}
                  {turn.cites.map((c, j) => (
                    <button key={j} className="au-cite" onClick={() => openCite(c)}>
                      {c.replace(/^\[\[|\]\]$/g, "")}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
