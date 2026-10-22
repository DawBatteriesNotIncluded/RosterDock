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
 * refuses this, a Windows that cannot nest jobs) the command runs all the same, or with `noJob` PowerShell exits
 * with that code instead (probeJob's question). PowerShell sets PSModulePath and
 * adds .CPL to PATHEXT (with none given, cmd.exe then finds no program): both go back to what `restore` says,
 * a value or none, so the command sees the environment the worker gave it. No cmdlet, only .NET: a cmdlet
 * loads its module, which in the tests' bare environment had PowerShell analyse every module again first (12 s
 * and more where this takes under one).
 */
function jobScript(
  comspec: string,
  line: string,
  restore: Record<string, string | undefined>,
  noJob?: number,
): string {
  // PowerShell ends a single-quoted string at any single quote, the typographic ones included.
  const quoted = (s: string) => `'${s.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    "  $name = [Reflection.AssemblyName]::new('RosterDockJob')",
    "  $module = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, 'Run').DefineDynamicModule('RosterDockJob')",
    "  $type = $module.DefineType('Kernel32', 'Public, Class')",
    "  $functions = @(",
    "    @('CreateJobObjectW', [IntPtr], @([IntPtr], [IntPtr])),",
    "    @('SetInformationJobObject', [bool], @([IntPtr], [int], [byte[]], [int])),",
    "    @('AssignProcessToJobObject', [bool], @([IntPtr], [IntPtr]))",
    "  )",
    "  foreach ($f in $functions) {",
    "    $method = $type.DefinePInvokeMethod($f[0], 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', $f[1], [Type[]]$f[2], 'Winapi', 'Unicode')",
    // As a [DllImport] has it: without PreserveSig .NET takes the return for an HRESULT and gives back 0.
    "    $method.SetImplementationFlags('PreserveSig')",
    "  }",
    "  $kernel32 = $type.CreateType()",
    "  $job = $kernel32::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)",
    "  if ($job -eq [IntPtr]::Zero) { throw 'no job object' }",
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (class 9), with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE in its LimitFlags.
    "  $limits = [byte[]]::new($(if ([IntPtr]::Size -eq 8) { 144 } else { 112 }))",
    "  [BitConverter]::GetBytes([uint32]0x2000).CopyTo($limits, 16)",
    "  if (-not $kernel32::SetInformationJobObject($job, 9, $limits, $limits.Length)) { throw 'no job limits' }",
    "  $self = [Diagnostics.Process]::GetCurrentProcess().Handle",
    "  if (-not $kernel32::AssignProcessToJobObject($job, $self)) { throw 'not in the job' }",
    // Asked (noJob), PowerShell says why there is no job on stderr before it exits.
    noJob === undefined
      ? "} catch {}"
      : `} catch { [Console]::Error.WriteLine($_.Exception.Message); exit ${noJob} }`,
    ...Object.entries(restore).map(
      ([name, value]) =>
        `[Environment]::SetEnvironmentVariable(${quoted(name)}, ${value === undefined ? "$null" : quoted(value)})`,
    ),
    "$start = [Diagnostics.ProcessStartInfo]::new()",
    `$start.FileName = ${quoted(comspec)}`,
    `$start.Arguments = ${quoted(`/d /s /c "${line}"`)}`,
    "$start.UseShellExecute = $false",
    "$command = [Diagnostics.Process]::Start($start)",
    "$command.WaitForExit()",
    "exit $command.ExitCode",
  ].join("\n");
}

/**
 * Windows: how to start `command` with `args` in `env` as cmd.exe would run them (npm, pnpm and yarn are .cmd
 * shims there), in a job, so that ending what this returns ends every process the command started, those
 * whose parent already ended included; and when the command ends by itself, whatever it left running ends
 * with it. Null without Windows PowerShell: start it under cmd.exe as it is (and so where jobsWork says no).
 * `noJob`: where no job can be made, exit with this code rather than run the command without one.
 */
export function inJob(
  command: string,
  args: string[],
  env: Record<string, string>,
  noJob?: number,
): { file: string; args: string[] } | null {
  const powershell = path.win32.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) return null;
  const comspec = process.env.ComSpec || path.win32.join(systemRoot(), "System32", "cmd.exe");
  // Names on Windows are any case.
  const given = (name: string) =>
    Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const restore = { PATHEXT: given("PATHEXT"), PSModulePath: given("PSModulePath") };
  const script = jobScript(comspec, [command, ...args].join(" "), restore, noJob);
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

/** What probeJob found: the job works, or why not. Null: no answer in time, which says nothing yet. */
export type JobProbe = { works: true } | { works: false; why: string } | null;

/** How long probeJob waits for Windows PowerShell: a first start under an antivirus scan can take seconds. */
export const PROBE_MS = 30_000;

/**
 * Whether the job can start a command here at all: Windows PowerShell starts (a rule may block it), runs the
 * script in full language mode (AppLocker and WDAC put it in Constrained Language, which refuses the .NET the
 * script calls, and it would exit before cmd.exe starts), makes the job, and starts the command through it.
 * Tried with a command that only exits 7; 8 says PowerShell ran but made no job.
 */
export function probeJob(): Promise<JobProbe> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const job = inJob("exit", ["7"], env, 8);
  if (!job) return Promise.resolve({ works: false, why: "there is no Windows PowerShell" });
  return new Promise((resolve) => {
    let child: ChildProcess;
    const refused = (err: NodeJS.ErrnoException) =>
      resolve({ works: false, why: `Windows PowerShell did not start (${err.code ?? err.message})` });
    let said = "";
    try {
      child = spawn(job.file, job.args, { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (c: string) => (said = (said + c).slice(0, 1000)));
    } catch (err) {
      // Where a rule blocks powershell.exe, the spawn throws (EPERM, UNKNOWN).
      return refused(err as NodeJS.ErrnoException);
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, PROBE_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      refused(err);
    });
    // On close, once its stderr has ended too: the reason it gave, whole.
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(
        code === 7
          ? { works: true }
          : code === 8
            ? {
                works: false,
                why: `Windows PowerShell could not make a job object here (${said.trim() || "it gave no reason"})`,
              }
            : {
                works: false,
                why: `Windows PowerShell exited ${code ?? "on a signal"} without starting the command (Constrained Language mode, which AppLocker and WDAC set, is one cause)`,
              },
      );
    });
  });
}

let jobs: Promise<boolean> | undefined;
let heard: ((answer: Exclude<JobProbe, null>) => void) | undefined;

/** Who hears probeJob's answer when it comes: the worker's log (main.ts). */
export function onJobAnswer(listener: (answer: Exclude<JobProbe, null>) => void): void {
  heard = listener;
}

/**
 * probeJob, asked once for this worker, and told to onJobAnswer's listener: a definite answer is kept; none in
 * time is no job for now, and asked again at the next command.
 */
export function jobsWork(): Promise<boolean> {
  jobs ??= probeJob().then((answer) => {
    if (!answer) jobs = undefined;
    heard?.(
      answer ?? {
        works: false,
        why: `Windows PowerShell did not answer in ${PROBE_MS / 1000} s, so it is asked again at the next tests`,
      },
    );
    return answer?.works ?? false;
  });
  return jobs;
}
