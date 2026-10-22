// A program by name on Windows, as a spawn without a shell starts it. npm installs a CLI there as a .cmd shim,
// which only cmd.exe runs: Node refuses to spawn one without a shell, and a shell would read the arguments
// again. Read for what it runs, the shim is passed over: a program as it is (Claude Code's native claude.exe,
// since 2.1.113), a script with the caller's Node (Codex's codex.js; Claude Code's cli.js before). Pure: the
// caller hands in its files and its path functions.

/** The file system and path functions resolveWindowsBin reads with. */
export interface WindowsBinFiles {
  isFile(p: string): boolean;
  /** A file's text; null when it cannot be read. */
  read(p: string): string | null;
  join(...parts: string[]): string;
  dirname(p: string): string;
}

/**
 * What a .cmd shim npm wrote (cmd-shim, npm 7 and later) runs, by its path from the shim's folder: a program,
 * or a script node runs. Null for any other .cmd, a shim that runs another interpreter or passes it arguments
 * included.
 */
export function npmShimTarget(cmd: string): { path: string[]; node: boolean } | null {
  const program = /^"%dp0%\\([^"\r\n]+)"[ \t]+%\*\s*$/m.exec(cmd);
  if (program) return { path: program[1]!.split("\\"), node: false };
  const script = /(?:^|&)[ \t]*"%_prog%"[ \t]+"%dp0%\\([^"\r\n]+)"[ \t]+%\*\s*$/m.exec(cmd);
  if (script && /^[ \t]*SET "_prog=node"\s*$/m.test(cmd)) return { path: script[1]!.split("\\"), node: true };
  return null;
}

/**
 * `bin` as Windows finds it, a path or a name looked for on `pathList` folder by folder (a program before a
 * shim in each), and as a spawn without a shell starts it: npm's shim by what it runs, a script with `node`.
 * A name found nowhere, or a .cmd npm did not write, as it is.
 */
export function resolveWindowsBin(
  bin: string,
  pathList: string[],
  node: string,
  files: WindowsBinFiles,
): { bin: string; prefix: string[] } {
  const withExt = /\.(?:exe|cmd)$/i.test(bin);
  const at = (base: string) => (withExt ? [base] : [`${base}.exe`, `${base}.cmd`]);
  const candidates = /[\\/]/.test(bin)
    ? at(bin)
    : pathList.filter(Boolean).flatMap((dir) => at(files.join(dir, bin)));
  const found = candidates.find((p) => files.isFile(p));
  if (!found) return { bin, prefix: [] };
  if (!/\.cmd$/i.test(found)) return { bin: found, prefix: [] };
  const text = files.read(found);
  const shim = text === null ? null : npmShimTarget(text);
  if (!shim) return { bin, prefix: [] };
  const target = files.join(files.dirname(found), ...shim.path);
  return shim.node ? { bin: node, prefix: [target] } : { bin: target, prefix: [] };
}
