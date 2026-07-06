// Structured JSON-line logger — the app's logging primitive. Each call emits a
// single JSON object on its own line so runs are greppable in the devtools
// console (and any captured stdout). No dependencies; routes to the matching
// console method by level.

export type LogLevel = "info" | "warn" | "error";

function emit(
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) =>
    emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) =>
    emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) =>
    emit("error", event, fields),
};
