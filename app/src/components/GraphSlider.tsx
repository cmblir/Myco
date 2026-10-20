import { useId, useState, type JSX } from "react";

/** A live range control with a precise, bounded numeric entry. */
export default function GraphSlider({
  label, hint, value, min, max, step, onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}): JSX.Element {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const decimals = String(step).split(".")[1]?.length ?? 0;
  const format = (number: number) => number.toFixed(decimals);
  const commit = (): void => {
    if (draft !== null && draft.trim() !== "") {
      const entered = Number(draft);
      if (Number.isFinite(entered)) {
        const bounded = Math.max(min, Math.min(max, entered));
        const snapped = min + Math.round((bounded - min) / step) * step;
        onChange(Number(format(Math.max(min, Math.min(max, snapped)))));
      }
    }
    setDraft(null);
  };

  return (
    <div className="graph-slider">
      <div className="graph-slider__row">
        <label id={`${id}-label`} htmlFor={`${id}-range`} className="graph-slider__label">
          {label}
        </label>
        <input
          type="number"
          className="graph-slider__number"
          aria-labelledby={`${id}-label`}
          aria-describedby={hint ? `${id}-hint` : undefined}
          min={min} max={max} step={step}
          value={draft ?? format(value)}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            const number = Number(next);
            // Keep partial/out-of-range typing local until blur or Enter.
            if (next.trim() && Number.isFinite(number) && number >= min && number <= max) {
              onChange(number);
            }
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
      <input
        id={`${id}-range`}
        type="range"
        min={min} max={max} step={step} value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => {
          setDraft(null);
          onChange(Number(event.target.value));
        }}
        className="graph-slider__input"
      />
      {hint ? <span id={`${id}-hint`} className="graph-toggle__hint">{hint}</span> : null}
    </div>
  );
}
