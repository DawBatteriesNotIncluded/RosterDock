// A department's tool list (its sandbox's allowedTools), engine by engine. The list is written in Claude
// Code's tool names and rules (Bash, Read(./**), WebFetch), which Claude Code takes as they are. Codex has no
// per-tool list, so the worker holds it to the list with Codex's own controls (the CLI the worker image
// pins): its sandbox, the network its commands get, and its web search. Where Codex cannot be held to the
// list, it does not run under it: the worker refuses the run before anything starts, and the board refuses
// to seat a Codex teammate in such a department. Pure, shared by the worker and the board.

/** The shell, named on its own: everything Codex reads or runs goes through it. */
const SHELLS = ["Bash", "PowerShell"];
/** Any of these, with or without a rule, lets Codex write in its workspace. */
const WRITES = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** A tool list as Claude Code takes it: comma or space separated, never inside a rule's parentheses. */
export function splitToolList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The tool a rule is for: `Read(./**)` is Read. */
export const toolName = (rule: string): string => rule.replace(/\(.*$/s, "");

/** What a department's tool list leaves a Codex teammate. */
export interface CodexReach {
  /** It may write in its workspace (Write, Edit, MultiEdit or NotebookEdit); without, it runs read-only. */
  write: boolean;
  /** Its commands may reach the network as far as the worker's sandbox lets them (WebFetch on its own). */
  network: boolean;
  /** It keeps Codex's web search (WebSearch). */
  webSearch: boolean;
}

/**
 * What a department's tool list leaves a Codex teammate, or why Codex cannot keep to it. No list narrows
 * nothing. Codex reads files and runs commands only through its shell, so a list must name the shell on its
 * own: a list without it, or with only some of its commands (`Bash(npm test:*)`), is refused. A rule that
 * narrows WebFetch to some sites does not keep the network, since Codex cannot hold its commands to them.
 */
export function codexReach(
  list: readonly string[] | null | undefined,
): ({ ok: true } & CodexReach) | { ok: false; reason: string } {
  const rules = (list ?? []).flatMap(splitToolList);
  if (!rules.length) return { ok: true, write: true, network: true, webSearch: true };
  const bare = new Set(rules.filter((r) => toolName(r) === r));
  const names = new Set(rules.map(toolName));
  if (!SHELLS.some((s) => bare.has(s))) {
    const some = rules.filter((r) => SHELLS.includes(toolName(r)));
    return {
      ok: false,
      reason: some.length
        ? `it cannot hold its shell to some commands, and the list allows only ${some.slice(0, 3).join(", ")}${some.length > 3 ? " and more" : ""}`
        : "it reads files and runs commands only through its shell, and the list leaves out Bash",
    };
  }
  return {
    ok: true,
    write: WRITES.some((w) => names.has(w)),
    network: bare.has("WebFetch"),
    webSearch: names.has("WebSearch"),
  };
}
