// Settings > Study — whether a chat model may draft study cards (spec
// 2026-09-29), and whether a review grades in four steps instead of two (UX
// S34). Both off by default: Make cards and the quiz quote the note with no
// model, and a review asks only Forgot or Remembered. Per device, like the
// other uiStore preferences.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../../lib/icons";
import type { Strings } from "../../lib/i18n";
import { canGenerate, getActiveModel } from "../../lib/chat";
import { useUIStore } from "../../stores/uiStore";
import { SettingsCard } from "../../components/SettingsCard";

export function SettingsStudy({ t }: { t: Strings }): JSX.Element {
  const aiCards = useUIStore((s) => s.aiCards);
  const setAiCards = useUIStore((s) => s.setAiCards);
  const fineGrades = useUIStore((s) => s.fineGrades);
  const setFineGrades = useUIStore((s) => s.setFineGrades);
  // null until known: the switch works either way, the hint needs the answer.
  const [hasModel, setHasModel] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    getActiveModel("study")
      .then((m) => alive && setHasModel(canGenerate(m.provider, m.model)))
      .catch(() => alive && setHasModel(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
          {t.nav_study}
        </h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_study_lede}
        </p>
      </div>
      {/* The checkbox shows the value; the corner chip would sit on top of it. */}
      <SettingsCard id="study_ai_cards" className="card" hideValue>
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            cursor: "pointer",
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, display: "block" }}>
              {t.s_ai_cards_title}
            </span>
            <span
              className="muted"
              style={{ fontSize: 12.5, display: "block", marginTop: 4 }}
            >
              {t.s_ai_cards_desc}
            </span>
          </span>
          <input
            type="checkbox"
            checked={aiCards}
            onChange={(e) => setAiCards(e.target.checked)}
          />
        </label>
        {aiCards && hasModel === false ? (
          <div
            className="row muted"
            style={{
              marginTop: 10,
              gap: 6,
              fontSize: 12.5,
              alignItems: "center",
            }}
          >
            <Icon name="info" size={12} /> {t.s_ai_cards_needs}
          </div>
        ) : null}
      </SettingsCard>
      <SettingsCard id="study_fine_grades" className="card" hideValue>
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            cursor: "pointer",
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, display: "block" }}>
              {t.s_fine_grades_title}
            </span>
            <span
              className="muted"
              style={{ fontSize: 12.5, display: "block", marginTop: 4 }}
            >
              {t.s_fine_grades_desc}
            </span>
          </span>
          <input
            type="checkbox"
            checked={fineGrades}
            onChange={(e) => setFineGrades(e.target.checked)}
          />
        </label>
      </SettingsCard>
    </div>
  );
}
