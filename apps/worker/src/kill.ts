// Windows has no process groups. A program ended on its own there leaves the programs it started running,
// and they hold its output pipes open, so the worker never sees it close. taskkill ends the whole tree, as far
// as it can walk it: down from a program still running, through the programs under it still running. One that
// ended leaves the ones it started out of reach; a job object reaches them all, whatever ended before them.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function systemRoot(): string {
  return process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
}

/** Windows: end `child` and every process under it, at once (taskkill /t /f); without taskkill, the child alone. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  let taskkill: ChildProcess;
  try {
    taskkill = spawn(
      path.win32.join(systemRoot(), "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
  } catch {
    // A spawn throws, not emits, most of what Windows says (EPERM where a policy refuses taskkill, UNKNOWN,
    // EFTYPE): in a timer that would end the worker.
    child.kill("SIGKILL");
    return;
  }
  taskkill.on("error", () => child.kill("SIGKILL"));
  taskkill.on("exit", (code) => {
    if (code !== 0) child.kill("SIGKILL");
  });
}

/**
 * What Windows PowerShell runs: it puts itself in a new job object, one that ends every process in it when its
 * last handle closes, which is when PowerShell ends, however it ends; starts the command line under cmd.exe,
 * which joins the job, as does everything it starts; waits for it and exits with its code. kernel32's job
 * functions are declared in memory, so nothing is compiled or written to disk. Without a job (a policy that
 * refuses this, a Windows that cannot nest jobs) the command runs all the same. PSModulePath, which PowerShell
 * sets, is taken out again: the command sees the environment the worker gave it.
 */
function jobScript(comspec: string, line: string): string {
  const quoted = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $name = New-Object Reflection.AssemblyName 'RosterDockJob'",
    "  $module = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, 'Run').DefineDynamicModule('RosterDockJob')",
    "  $type = $module.DefineType('Kernel32', 'Public, Class')",
    "  $functions = @(",
    "    @('CreateJobObjectW', [IntPtr], @([IntPtr], [IntPtr])),",
    "    @('SetInformationJobObject', [bool], @([IntPtr], [int], [byte[]], [int])),",
    "    @('AssignProcessToJobObject', [bool], @([IntPtr], [IntPtr]))",
    "  )",
    "  foreach ($f in $functions) {",
    "    [void]$type.DefinePInvokeMethod($f[0], 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', $f[1], [Type[]]$f[2], 'Winapi', 'Unicode')",
    "  }",
    "  $kernel32 = $type.CreateType()",
    "  $job = $kernel32::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)",
    "  if ($job -eq [IntPtr]::Zero) { throw 'no job object' }",
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (class 9), with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE in its LimitFlags.
    "  $limits = New-Object byte[] $(if ([IntPtr]::Size -eq 8) { 144 } else { 112 })",
    "  [BitConverter]::GetBytes([uint32]0x2000).CopyTo($limits, 16)",
    "  if (-not $kernel32::SetInformationJobObject($job, 9, $limits, $limits.Length)) { throw 'no job limits' }",
    "  $self = [Diagnostics.Process]::GetCurrentProcess().Handle",
    "  if (-not $kernel32::AssignProcessToJobObject($job, $self)) { throw 'not in the job' }",
    "} catch {}",
    "Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue",
    "$start = New-Object Diagnostics.ProcessStartInfo",
    `$start.FileName = ${quoted(comspec)}`,
    `$start.Arguments = ${quoted(`/d /s /c "${line}"`)}`,
    "$start.UseShellExecute = $false",
    "$command = [Diagnostics.Process]::Start($start)",
    "$command.WaitForExit()",
    "exit $command.ExitCode",
  ].join("\n");
}

/**
 * Windows: how to start `command` with `args` as cmd.exe would run them (npm, pnpm and yarn are .cmd shims
 * there), in a job, so that ending what this returns ends every process the command started, those whose
 * parent already ended included; and when the command ends by itself, whatever it left running ends with it.
 * Null without Windows PowerShell: start it under cmd.exe as it is.
 */
export function inJob(command: string, args: string[]): { file: string; args: string[] } | null {
  const powershell = path.win32.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) return null;
  const comspec = process.env.ComSpec || path.win32.join(systemRoot(), "System32", "cmd.exe");
  const script = jobScript(comspec, [command, ...args].join(" "));
  return {
    file: powershell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}
