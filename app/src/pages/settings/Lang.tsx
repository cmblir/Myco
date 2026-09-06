// Settings > Language — the UI language (the model's drafting language is
// a separate setting).

import type { JSX } from "react";
import type { Lang, Strings } from "../../lib/i18n";
import { SettingsCard } from "../../components/SettingsCard";

export function SettingsLang({
  t,
  lang,
  setLang,
}: {
  t: Strings;
  lang: Lang;
  setLang: (l: Lang) => void;
}): JSX.Element {
  const opts: { id: Lang; name: string; native: string }[] = [
    { id: "en", name: "English", native: "English" },
    { id: "ko", name: "Korean", native: "한국어" },
    { id: "ja", name: "Japanese", native: "日本語" },
  ];
  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{t.s_lang}</h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_lang_lede}
        </p>
      </div>
      <SettingsCard id="lang_ui" className="card">
        <div style={{ fontWeight: 600, marginBottom: 10 }}>{t.s_lang_ui}</div>
        <div className="col" style={{ gap: 6 }}>
          {opts.map((o) => {
            const sel = lang === o.id;
            return (
              <button
                key={o.id}
                className="card-flat"
                style={{
                  padding: 12,
                  border: `1px solid ${sel ? "var(--ink)" : "transparent"}`,
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 12,
                  alignItems: "center",
                  textAlign: "left",
                  cursor: "pointer",
                  background: sel ? "var(--bg)" : "var(--bg-soft)",
                }}
                onClick={() => setLang(o.id)}
              >
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: "var(--ink)",
                    width: 28,
                    textAlign: "center",
                  }}
                >
                  {o.id === "en" ? "Aa" : o.id === "ko" ? "가" : "あ"}
                </span>
                <div>
                  <div style={{ fontWeight: 500 }}>{o.native}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {o.name}
                  </div>
                </div>
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    border: `1.5px solid ${sel ? "var(--ink)" : "var(--line-strong)"}`,
                    background: sel ? "var(--ink)" : "transparent",
                  }}
                />
              </button>
            );
          })}
        </div>
      </SettingsCard>
    </div>
  );
}
