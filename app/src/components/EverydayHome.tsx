import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { promptNewNote } from "../lib/newNote";
import { useUIStore } from "../stores/uiStore";
import MycoMotion from "./MycoMotion";
import { Button } from "./ui";
import "../styles/everyday.css";

/** The everyday actions, using the same flows as the sidebar. */
export default function EverydayHome({
  t,
  hasVault,
}: {
  t: Strings;
  hasVault: boolean;
}): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  return (
    <section className="everyday-home" aria-label={t.nav_overview}>
      <div className="everyday-hero">
        <div className="everyday-hero__copy">
          <h2>{t.home_title}</h2>
          <p>{hasVault ? t.home_intro : t.home_no_vault}</p>
          <Button
            variant="primary"
            onClick={() => {
              if (hasVault) setRoute("ingest");
              else {
                setSettingsTab("account");
                setRoute("settings");
              }
            }}
          >
            <Icon name={hasVault ? "plus" : "folder"} size={18} />
            {hasVault ? t.home_add : t.home_choose_vault}
          </Button>
          {hasVault ? (
            <span className="everyday-hero__hint">{t.home_add_hint}</span>
          ) : null}
        </div>
        <MycoMotion
          variant="welcome"
          size={170}
          className="everyday-hero__mascot"
        />
      </div>
      <div className="everyday-actions">
        {/* With a vault Home has its own ask box above, so a second way in to
            the same question was one too many (UX S19). */}
        {hasVault ? null : (
          <button type="button" disabled onClick={() => setRoute("query")}>
            <span className="everyday-actions__icon">
              <Icon name="msg" size={22} />
            </span>
            <span>
              <strong>{t.home_ask}</strong>
              <span>{t.home_ask_hint}</span>
            </span>
            <Icon name="arrowR" size={18} />
          </button>
        )}
        <button
          type="button"
          disabled={!hasVault}
          onClick={() => void promptNewNote(t)}
        >
          <span className="everyday-actions__icon">
            <Icon name="edit" size={22} />
          </span>
          <span>
            <strong>{t.home_write}</strong>
            <span>{t.home_write_hint}</span>
          </span>
          <Icon name="arrowR" size={18} />
        </button>
      </div>
    </section>
  );
}
