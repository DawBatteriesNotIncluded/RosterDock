// An engine's CLI by name. On Windows npm installs claude and codex as .cmd shims, which a spawn without a
// shell cannot start: the worker starts what the shim would, Claude Code's claude.exe as it is and a script
// with this Node.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveWindowsBin } from "@rosterdock/shared";

/** `bin` as the engine's spawn starts it: on Windows found as Windows finds it and an npm shim passed over; elsewhere as it is. */
export function resolveEngineBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): { bin: string; prefix: string[] } {
  if (platform !== "win32") return { bin, prefix: [] };
  return resolveWindowsBin(bin, (env.Path || env.PATH || "").split(path.delimiter), process.execPath, {
    isFile: (p) => {
      // Not only not-found: a folder this account cannot read, a share that is gone, a drive not ready.
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    join: path.join,
    dirname: path.dirname,
  });
}
