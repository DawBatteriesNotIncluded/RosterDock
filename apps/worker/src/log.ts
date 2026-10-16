// The worker's log: one JSON object per line in a cluster (what a log
// pipeline wants), plain lines on a terminal. Never a credential: the worker
// logs run ids, steps and outcomes, and error messages that the board client
// and the engines already keep values out of.

export type LogFormat = "json" | "text";

export interface WorkerLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export function formatLine(
  format: LogFormat,
  level: "info" | "warn",
  base: Record<string, unknown>,
  msg: string,
  fields: Record<string, unknown> | undefined,
  at: Date,
): string {
  if (format === "json")
    return JSON.stringify({ level, time: at.toISOString(), ...base, msg, ...(fields ?? {}) });
  const extra = fields ? " " + JSON.stringify(fields) : "";
  return `[worker ${String(base.worker ?? "")}] ${msg}${extra}`;
}

/** json unless ROSTERDOCK_LOG_FORMAT says text or stdout is a terminal. */
export function logFormatFrom(env: NodeJS.ProcessEnv, isTty: boolean): LogFormat {
  const v = env.ROSTERDOCK_LOG_FORMAT?.trim().toLowerCase();
  if (v === "json" || v === "text") return v;
  return isTty ? "text" : "json";
}

export function createLog(
  format: LogFormat,
  base: Record<string, unknown>,
  out: { stdout(line: string): void; stderr(line: string): void } = {
    stdout: (l) => process.stdout.write(l + "\n"),
    stderr: (l) => process.stderr.write(l + "\n"),
  },
): WorkerLog {
  return {
    info: (msg, fields) => out.stdout(formatLine(format, "info", base, msg, fields, new Date())),
    warn: (msg, fields) => out.stderr(formatLine(format, "warn", base, msg, fields, new Date())),
  };
}
