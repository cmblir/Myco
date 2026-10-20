import { useEffect, type JSX } from "react";
import type { Lang } from "../../lib/i18n";
import { localModelCopy } from "../../lib/localModelCopy";
import {
  BUILTIN_CHAT_MODEL,
  BUILTIN_FAST_CHAT_MODEL,
  BUILTIN_MODEL,
} from "../../lib/providers";
import {
  useFastLocalModelStore,
  useLocalModelStore,
} from "../../stores/localModelStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { SettingsCard } from "../../components/SettingsCard";
import { Button } from "../../components/ui";

export function SettingsLocalModel({
  lang,
  modelId = BUILTIN_CHAT_MODEL,
}: {
  lang: Lang;
  modelId?: typeof BUILTIN_CHAT_MODEL | typeof BUILTIN_FAST_CHAT_MODEL;
}): JSX.Element {
  const isFast = modelId === BUILTIN_FAST_CHAT_MODEL;
  const useModelStore = isFast ? useFastLocalModelStore : useLocalModelStore;
  const useOtherModelStore = isFast
    ? useLocalModelStore
    : useFastLocalModelStore;
  const c = localModelCopy(lang, modelId);
  const stage = useModelStore((s) => s.stage);
  const pct = useModelStore((s) => s.pct);
  const cancelling = useModelStore((s) => s.cancelling);
  const error = useModelStore((s) => s.error);
  const checkStatus = useModelStore((s) => s.checkStatus);
  const download = useModelStore((s) => s.download);
  const cancelDownload = useModelStore((s) => s.cancelDownload);
  const selectForAsk = useModelStore((s) => s.selectForAsk);
  const selectForIngest = useModelStore((s) => s.selectForIngest);
  const otherDownloading = useOtherModelStore((s) => s.stage === "downloading");
  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const settingsError = useSettingsStore((s) => s.error);
  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);
  const onQwen =
    settings?.model_roles?.roles.ask.providerId === "builtin-local" &&
    settings.model_roles?.roles.ask.modelId === modelId;
  const onIngest =
    settings?.model_roles?.roles.compilation.providerId === "builtin-local" &&
    settings.model_roles?.roles.compilation.modelId === modelId;
  const onQuotes =
    settings?.model_roles?.roles.ask.providerId === "builtin-local" &&
    settings.model_roles?.roles.ask.modelId === BUILTIN_MODEL;
  const isDownloading = stage === "downloading";
  const statusText = cancelling
    ? c.cancelling
    : isDownloading && pct === 100
      ? c.verifying
      : c[stage];
  const buttonStyle = { minHeight: "max(44px, 2.75rem)" };

  return (
    <SettingsCard
      id={isFast ? "model_local_generation_fast" : "model_local_generation"}
      hideValue
    >
      <h3 style={{ margin: 0, fontSize: "1rem" }}>{c.title}</h3>
      <p className="muted" style={{ margin: "0.5rem 0" }}>
        {c.lede}
      </p>
      <p
        className="muted"
        style={{ fontSize: "0.8125rem", margin: "0.5rem 0" }}
      >
        {c.footprint}
      </p>
      <p
        role={stage === "error" ? "alert" : "status"}
        aria-live="polite"
        style={{ margin: "0.75rem 0" }}
      >
        {statusText}
      </p>
      {isDownloading ? (
        <div
          className="row"
          style={{ gap: "0.75rem", marginBottom: "0.75rem" }}
        >
          <progress
            aria-label={c.progress}
            value={pct}
            max={100}
            style={{ flex: 1, minWidth: 0 }}
          />
          <span>
            {new Intl.NumberFormat(lang, {
              style: "percent",
              maximumFractionDigits: 0,
            }).format(pct / 100)}
          </span>
        </div>
      ) : null}
      {error ? (
        <details style={{ marginBottom: "0.75rem", overflowWrap: "anywhere" }}>
          <summary>{c.details}</summary>
          <p>{error}</p>
        </details>
      ) : null}
      {settingsError ? <p role="alert">{c.selectionError}</p> : null}
      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        {stage === "missing" || stage === "error" ? (
          <Button
            variant="primary"
            style={buttonStyle}
            disabled={otherDownloading}
            onClick={() => void download()}
          >
            {stage === "error" ? c.retry : c.install}
          </Button>
        ) : null}
        {isDownloading ? (
          <Button
            style={buttonStyle}
            disabled={cancelling}
            onClick={() => void cancelDownload()}
          >
            {c.cancel}
          </Button>
        ) : (
          <Button
            style={buttonStyle}
            disabled={stage === "checking"}
            onClick={() => void checkStatus()}
          >
            {c.check}
          </Button>
        )}
        <Button
          style={buttonStyle}
          disabled={stage !== "ready" || onQwen || saving || !settings}
          onClick={() => void selectForAsk("generation")}
        >
          {onQwen ? c.selected : c.use}
        </Button>
        <Button
          style={buttonStyle}
          disabled={stage !== "ready" || onIngest || saving || !settings}
          onClick={() => void selectForIngest()}
        >
          {onIngest ? c.ingestSelected : c.useForIngest}
        </Button>
        {!isFast ? (
          <Button
            style={buttonStyle}
            disabled={onQuotes || saving || !settings}
            onClick={() => void selectForAsk("quotes")}
          >
            {onQuotes ? c.quotesSelected : c.quotes}
          </Button>
        ) : null}
      </div>
    </SettingsCard>
  );
}
