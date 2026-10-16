// What a proposed write writes to: the arguments that name the thing (a path,
// a URI, an id), not the ones that carry what is written. Two proposals from
// one task for the same connection, tool and target are the same write, so
// the newer one replaces the older while it waits, and a goal's result can
// say what each target holds now. A payload with none of these has no target.
//
// A path under a directory the connection was started with (the MCP
// filesystem server's allowed directory, say) is named relative to it, so the
// absolute and the relative spelling of one file are one target: live on
// Lighthouse, #31's draft named the drive file absolutely and its correction
// relatively.

import os from "node:os";
import path from "node:path";

const NAMING_KEYS = /^(path|file|filename|file_?path|uri|url|id|key|slug|name)$|(_id|Id)$/;
const PATH_KEYS = /^(path|file|filename|file_?path)$/;

export interface WriteTarget {
  /** Canonical: the naming arguments, sorted, as JSON. */
  key: string;
  /** For people: the values, joined. */
  label: string;
}

/**
 * The absolute directories among a connection's start arguments. `~` is the
 * board's home, as for the child the board starts (Lighthouse's drive is
 * `~/Lighthouse/drive`).
 */
export function connectionRoots(args: unknown, home: string = os.homedir()): string[] {
  if (!Array.isArray(args)) return [];
  return args
    .filter((a): a is string => typeof a === "string")
    .map((a) => (a === "~" ? home : a.startsWith("~/") ? path.posix.join(home, a.slice(2)) : a))
    .filter((a) => path.posix.isAbsolute(a))
    .map((a) => path.posix.normalize(a).replace(/\/+$/, "") || "/");
}

function namePath(value: string, roots: string[]): string {
  const p = path.posix.normalize(value);
  for (const root of roots) {
    if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  return p.replace(/^\.\//, "");
}

export function writeTarget(payload: Record<string, unknown>, roots: string[] = []): WriteTarget | null {
  const pairs = Object.entries(payload)
    .filter(([k, v]) => NAMING_KEYS.test(k) && (typeof v === "string" || typeof v === "number"))
    .map(([k, v]) => [k, PATH_KEYS.test(k) && typeof v === "string" ? namePath(v, roots) : v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!pairs.length) return null;
  return { key: JSON.stringify(pairs), label: pairs.map(([, v]) => String(v)).join(" · ") };
}
