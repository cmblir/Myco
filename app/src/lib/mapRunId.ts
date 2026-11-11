/** Keep native's llm-<seconds>-<digits> shape without reusing a consumed run. */
export function newMapRunId(): string {
  const entropy = crypto.getRandomValues(new Uint32Array(2));
  const suffix = Array.from(entropy, word => String(word).padStart(10, "0")).join("");
  return `llm-${Math.floor(Date.now() / 1000)}-${suffix}`;
}
