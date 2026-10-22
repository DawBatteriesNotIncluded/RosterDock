// A program by name on Windows, as a spawn without a shell starts it. npm installs a CLI there as a .cmd shim,
// which only cmd.exe runs: Node refuses to spawn one without a shell, and a shell would read the arguments
// again. Read for what it runs, the shim is passed over: a program as it is (Claude Code's native claude.exe,
// since 2.1.113), a script with the caller's Node (Codex's codex.js; Claude Code's cli.js before). Pure: the
// caller hands in its files and its path functions.

/** The file system and path functions resolveWindowsBin reads with. */
export interface WindowsBinFiles {
  /** Whether a file is there; a throw is taken as no. */
  isFile(p: string): boolean;
  /** A file's text; null when it cannot be read. */
  read(p: string): string | null;
  join(...parts: string[]): string;
  dirname(p: string): string;
}

/**
 * What a .cmd shim npm wrote (cmd-shim, npm 7 and later) runs, by its path from the shim's folder: a program,
 * or a script node runs. Read from the line that runs it, as npm writes it, so a .cmd of another's that holds
 * such a line reads the same. Null for a .cmd without one, or whose line runs another interpreter or passes it
 * arguments.
 */
export function npmShimTarget(cmd: string): { path: string[]; node: boolean } | null {
  const program = /^"%dp0%\\([^"\r\n]+)"[ \t]+%\*\s*$/m.exec(cmd);
  if (program) return { path: program[1]!.split("\\"), node: false };
  const script = /(?:^|&)[ \t]*"%_prog%"[ \t]+"%dp0%\\([^"\r\n]+)"[ \t]+%\*\s*$/m.exec(cmd);
  if (script && /^[ \t]*SET "_prog=node"\s*$/m.test(cmd)) return { path: script[1]!.split("\\"), node: true };
  return null;
}

/**
 * `bin` as a path, or a name looked for on `pathList` folder by folder: a program (.com, .exe) before a shim
 * (.cmd) in each, a folder in quotes taken without them, a folder that cannot be read (no access, a share that
 * is gone, a drive not ready) passed over, as Windows does. Then as a spawn without a shell starts it: npm's
 * shim by what it runs, a script with `node`. A name found nowhere, or a .cmd npm did not write, as it is.
 */
export function resolveWindowsBin(
  bin: string,
  pathList: string[],
  node: string,
  files: WindowsBinFiles,
): { bin: string; prefix: string[] } {
  const withExt = /\.(?:com|exe|cmd)$/i.test(bin);
  const at = (base: string) => (withExt ? [base] : [`${base}.com`, `${base}.exe`, `${base}.cmd`]);
  const folders = pathList.map((dir) => dir.replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const candidates = /[\\/]/.test(bin) ? at(bin) : folders.flatMap((dir) => at(files.join(dir, bin)));
  const here = (p: string) => {
    try {
      return files.isFile(p);
    } catch {
      return false;
    }
  };
  const found = candidates.find(here);
  if (!found) return { bin, prefix: [] };
  if (!/\.cmd$/i.test(found)) return { bin: found, prefix: [] };
  const text = files.read(found);
  const shim = text === null ? null : npmShimTarget(text);
  if (!shim) return { bin, prefix: [] };
  const target = files.join(files.dirname(found), ...shim.path);
  return shim.node ? { bin: node, prefix: [target] } : { bin: target, prefix: [] };
}
