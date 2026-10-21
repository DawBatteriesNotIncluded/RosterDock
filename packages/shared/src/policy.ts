// Tool policy: what a teammate may do with a connection, and how department
// and project policy narrow it. Pure functions, shared by the board (the broker
// decides with them) and the web (the toolbox editor explains with them).
//
// Three modes. off: the connection is not in the toolbox. read: reads run,
// writes are refused. ask: reads run, writes are proposed for a person to
// approve. There is no mode that lets a live write skip the gate; the plan's
// "auto" was dropped for that reason (docs/m5.md).
//
// Policy only narrows. The teammate's toolbox is the ceiling; the department's
// write policy caps it (readonly departments never write); the project's client
// policy caps it again, per connection or for every connection.

import type { WritePolicy } from "./schemas.js";

export const TOOL_MODES = ["off", "read", "ask"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

const RANK: Record<ToolMode, number> = { off: 0, read: 1, ask: 2 };

export function isToolMode(value: unknown): value is ToolMode {
  return typeof value === "string" && (TOOL_MODES as readonly string[]).includes(value);
}

/** The narrower of two modes. */
export function narrowerMode(a: ToolMode, b: ToolMode): ToolMode {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * One line of a teammate's toolbox: a connection by name, the mode granted on it and, optionally, only
 * some of its tools. Absent or null: every tool on the connection.
 */
export interface ToolboxEntry {
  connection: string;
  mode: ToolMode;
  tools?: string[] | null;
}

/** Whether a toolbox line grants one tool: every tool unless the line names some, then only those. */
export function toolGranted(entry: Pick<ToolboxEntry, "tools"> | null | undefined, tool: string): boolean {
  if (!entry) return false;
  return !entry.tools || entry.tools.includes(tool);
}

/**
 * A project's client policy: what this client lets any teammate do with each
 * connection. `caps` names connections; `default` applies to the rest. Null or
 * absent means the policy says nothing and narrows nothing.
 */
export interface ClientPolicy {
  default?: ToolMode | null;
  caps?: Record<string, ToolMode>;
}

/** What a department's write policy allows a tool to do: readonly departments read only. */
export function departmentCap(writePolicy: WritePolicy | string | null | undefined): ToolMode {
  return writePolicy === "readonly" ? "read" : "ask";
}

export interface PolicyInput {
  /** The teammate's toolbox. A connection not named is off. */
  toolbox: ToolboxEntry[];
  /** The task's department write policy, when the task has a department. */
  departmentWritePolicy?: WritePolicy | string | null;
  /** The task's project client policy. */
  clientPolicy?: ClientPolicy | null;
  connection: string;
}

export interface PolicyDecision {
  mode: ToolMode;
  /** What set the ceiling and what narrowed it, in manager language, for the pack and the UI. */
  narrowedBy: ("toolbox" | "department" | "client")[];
}

/** The effective mode of one connection for one teammate on one task. */
export function effectiveMode(input: PolicyInput): PolicyDecision {
  const granted = input.toolbox.find((t) => t.connection === input.connection)?.mode ?? "off";
  const narrowedBy: PolicyDecision["narrowedBy"] = [];
  let mode: ToolMode = granted;
  if (granted === "off") narrowedBy.push("toolbox");
  const dept = departmentCap(input.departmentWritePolicy);
  if (RANK[dept] < RANK[mode]) {
    mode = dept;
    narrowedBy.push("department");
  }
  const policy = input.clientPolicy;
  const clientCap = policy?.caps?.[input.connection] ?? policy?.default ?? null;
  if (clientCap && RANK[clientCap] < RANK[mode]) {
    mode = clientCap;
    narrowedBy.push("client");
  }
  return { mode, narrowedBy };
}

/** What a mode lets a tool of a given classification do. */
export type ToolVerdict = "run" | "propose" | "refuse";

export function verdictFor(mode: ToolMode, write: boolean): ToolVerdict {
  if (mode === "off") return "refuse";
  if (!write) return "run";
  return mode === "ask" ? "propose" : "refuse";
}

// --- Read or write ------------------------------------------------------------
//
// A tool is a write unless something says it is a read: the catalog's list for
// that connector, or a name that starts with a reading verb and joins no second
// verb to it. A server's readOnlyHint annotation counts only with one of those:
// a careless or dishonest server could label a write read-only, so a tool the
// label alone calls a read is a write until a person confirms it. readOnlyHint
// false, destructiveHint true and the catalog's list of writes make a write
// whatever else says read. The conservative default keeps an unknown tool
// behind the gate.
//
// Export, preview and check are not reading verbs: an export sends data out or
// starts a job, a preview is often built or sent, and check_in or a check run
// changes state. get_or_create and find_and_replace write.

const READ_VERB_RE =
  /^(get|list|search|read|find|describe|query|fetch|lookup|look_up|count|show|view|inspect|summari[sz]e|retrieve|browse)(?![a-z])/i;
const JOINED_VERB_RE = /[-_.\s](and|or|then)(?=[-_.\s]|$)/i;

/** Whether a tool's name alone makes it a read. A namespace prefix (hubspot.search_companies, slack:read_channel) does not hide the verb. */
export function readsByName(name: string): boolean {
  const bare = name.replace(/^[a-z0-9-]+[.:]/i, "");
  return READ_VERB_RE.test(bare) && !JOINED_VERB_RE.test(bare);
}

export interface ToolHints {
  /** MCP tool annotations, when the server sends them. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
  /** The catalog's known reads and writes for this connector. */
  catalog?: { reads?: string[]; writes?: string[] } | null;
}

/**
 * What classified a tool. "unconfirmed": the server labels it read-only and nothing else says it reads, so it
 * is a write until a person confirms it; their word is then "person", and discovery keeps it.
 */
export type ToolClassSource = "annotation" | "catalog" | "name" | "default" | "person" | "unconfirmed";

export function classifyTool(
  name: string,
  hints: ToolHints = {},
): { write: boolean; source: ToolClassSource } {
  const annotations = hints.annotations;
  if (annotations?.readOnlyHint === false || annotations?.destructiveHint === true)
    return { write: true, source: "annotation" };
  if (hints.catalog?.writes?.includes(name)) return { write: true, source: "catalog" };
  const listed = hints.catalog?.reads?.includes(name) === true;
  if (annotations?.readOnlyHint === true)
    return listed || readsByName(name)
      ? { write: false, source: "annotation" }
      : { write: true, source: "unconfirmed" };
  if (listed) return { write: false, source: "catalog" };
  if (readsByName(name)) return { write: false, source: "name" };
  return { write: true, source: "default" };
}
