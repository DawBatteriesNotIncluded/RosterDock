// Windows has no process groups. A program ended on its own there leaves the programs it started running,
// and they hold its output pipes open, so the worker never sees it close. taskkill ends the whole tree.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Windows: end `child` and every process under it, at once (taskkill /t /f); without taskkill, the child alone. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const windows = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const taskkill = spawn(
    path.win32.join(windows, "System32", "taskkill.exe"),
    ["/pid", String(child.pid), "/t", "/f"],
    { stdio: "ignore", windowsHide: true },
  );
  taskkill.on("error", () => child.kill("SIGKILL"));
  taskkill.on("exit", (code) => {
    if (code !== 0) child.kill("SIGKILL");
  });
}
