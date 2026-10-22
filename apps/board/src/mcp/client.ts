// The board's MCP client: one purpose, let the broker list and call tools on
// a connection the policy already allowed. Two transports: Streamable HTTP
// (through the board's egress, web/egress.ts: every request's address checked,
// no redirect followed; tests inject its transport and replay recorded
// JSON-RPC) and stdio (a child
// process the board spawns, only for a command line the operator lists in
// ROSTERDOCK_STDIO_COMMANDS; tests spawn a fixture replayer). A stdio child is
// kept between calls in a pool keyed by the company, the connection's
// command, arguments and env var names and a hash of the values they
// resolved to, and closed when idle or when a call fails on it; HTTP is a
// request each time. Every decision about what may be called happens
// before this module; it never widens anything.
//
// Secrets: a connection names an env var; the value is read here at call time,
// from `deps.env` (for a company: its secrets over the names the board shares,
// secrets/company.ts; never the board's whole environment), travels in the
// Authorization header or the child's environment, and is scrubbed from any
// error text. It is never stored or returned.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { sha256Hex, type StdioCommand } from "@rosterdock/shared";
import { stdioRefusal } from "../operator.js";
import { notSetForCompany } from "../secrets/company.js";
import type { SecretStore } from "../secrets/store.js";
import { isExpiring, refreshTokens, resourceAllowed, type TokenAuth } from "./oauth.js";
import { defaultEgress, egressFetch, READ_NO_FURTHER, readBudget, type Egress } from "../web/egress.js";
import type { WebReader } from "../web/transport.js";

export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MCP_RESULT_MAX_CHARS = 200_000;
/** The most of one answer the board reads from an MCP server, decoded: a tools/list, a result, an event stream. */
export const MCP_ANSWER_MAX_BYTES = 8 * 1024 * 1024;
/** The most every answer of one call reads together, decoded: a stream the SDK resumes again and again included. */
export const MCP_CALL_MAX_BYTES = 16 * 1024 * 1024;
/** The most requests one call makes: a tools/list paged a few at a time fits; a stream resumed for ever does not. */
export const MCP_CALL_MAX_REQUESTS = 2000;

export interface McpTarget {
  transport: "http" | "stdio";
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  /** Env var NAME: the bearer token for http, handed to the child for stdio. */
  authEnvName?: string | null;
  /** More env var NAMES handed to a stdio child. */
  envNames?: string[] | null;
  /** Authorised by OAuth: the tokens live in the secret store under this name (http only). */
  oauth?: McpOAuthTarget | null;
}

export interface McpOAuthTarget {
  secretName: string;
  tokenEndpoint: string | null;
  clientId: string | null;
  /** The MCP server URL, the resource the tokens were issued for. */
  resource: string | null;
  /** How the secret reaches the token endpoint on a refresh; null: basic. */
  tokenAuth: TokenAuth | null;
  /** A pre-registered client's secret, by env var NAME; the store holds one instead when the board registered itself. */
  clientSecretEnvName: string | null;
}

export interface McpClientDeps {
  /**
   * How an HTTP connection, its OAuth refresh and an OpenAPI service are reached: public addresses and the
   * private ones the operator lists (web/egress.ts). Tests inject its transport and resolver. Default: the
   * board's own, with nothing private allowed.
   */
  egress?: Egress;
  /** Where env var names resolve: a company's secrets over the names the board shares (withCompanyEnv). Default: none. */
  env?: NodeJS.ProcessEnv;
  /** Where OAuth tokens live. Without one, an OAuth connection cannot be called. */
  secrets?: SecretStore | null;
  now?: () => number;
  log?: { warn(msg: string): void };
  timeoutMs?: number;
  /** Keeps stdio children between calls. Without one, a child per call. */
  pool?: McpClientPool;
  /** The command lines a stdio connection may run (ROSTERDOCK_STDIO_COMMANDS). Without them, none is started. */
  stdioCommands?: readonly StdioCommand[];
  /** Whose pooled children these are: the company (withCompanyEnv). A child never serves another scope. */
  poolScope?: string;
  /** What the web connection reads pages with (web/transport.ts). Null or absent: the board is kept off the web. */
  web?: WebReader | null;
}

export const MCP_POOL_IDLE_MS = 5 * 60_000;

/** Connected clients by key; an idle one is closed after `idleMs`, a failed one at once. */
export interface McpClientPool {
  acquire(key: string, connect: () => Promise<Client>): Promise<Client>;
  /** Drop and close the client under `key` (only if it is still `client`, when given). */
  evict(key: string, client?: Client): Promise<void>;
  stats(): { open: number; connects: number };
  closeAll(): Promise<void>;
}

export function mcpClientPool(opts: { idleMs?: number } = {}): McpClientPool {
  const idleMs = opts.idleMs ?? MCP_POOL_IDLE_MS;
  const entries = new Map<string, { client: Client; timer: NodeJS.Timeout }>();
  const pending = new Map<string, Promise<Client>>();
  let connects = 0;
  const touch = (key: string, client: Client) => {
    const old = entries.get(key);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => void pool.evict(key, client), idleMs);
    timer.unref();
    entries.set(key, { client, timer });
  };
  const pool: McpClientPool = {
    async acquire(key, connect) {
      const live = entries.get(key);
      if (live) {
        touch(key, live.client);
        return live.client;
      }
      let p = pending.get(key);
      if (!p) {
        p = (async () => {
          const client = await connect();
          connects += 1;
          // A child that exits (or a server that hangs up) leaves the pool on its own.
          client.onclose = () => void pool.evict(key, client);
          touch(key, client);
          return client;
        })();
        pending.set(key, p);
        p.finally(() => pending.delete(key)).catch(() => {});
      }
      return p;
    },
    async evict(key, client) {
      const live = entries.get(key);
      if (!live || (client && live.client !== client)) return;
      clearTimeout(live.timer);
      entries.delete(key);
      live.client.onclose = undefined;
      await live.client.close().catch(() => {});
    },
    stats: () => ({ open: entries.size, connects }),
    async closeAll() {
      await Promise.all([...entries.keys()].map((k) => pool.evict(k)));
    },
  };
  return pool;
}

/**
 * What makes two stdio targets the same child: the company, the command, its arguments, the env var NAMES
 * and what they resolve to (hashed, kept in memory only), so a company never reaches a child started with
 * another's values, and a rotated value starts a new child.
 */
function poolKey(target: McpTarget, scope: string, env: NodeJS.ProcessEnv): string {
  const names = [...(target.envNames ?? []), ...(target.authEnvName ? [target.authEnvName] : [])];
  return JSON.stringify([
    scope,
    target.command,
    target.args ?? [],
    target.authEnvName ?? null,
    target.envNames ?? [],
    sha256Hex(JSON.stringify(names.map((n) => env[n] ?? null))),
  ]);
}

export interface DiscoveredTool {
  name: string;
  description: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
  inputSchema: unknown;
}

export type McpCallOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Values that must never appear in text that leaves this module. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out;
}

/** The connection cannot be called as it stands (a missing credential, no URL); a 409 at the API. */
export class McpTargetError extends Error {
  readonly statusCode = 409;
}

/**
 * The bearer for this target: the env var's value, or the connection's OAuth
 * access token from the store, refreshed first when it is about to expire
 * (the store keeps the new pair). Never stored or returned beyond here.
 */
async function resolveCredential(target: McpTarget, deps: McpClientDeps): Promise<string | null> {
  if (target.oauth) {
    // A row kept from before the board checked the resource a server declares: its token is for something
    // else, so it is neither sent nor refreshed.
    if (target.oauth.resource && target.url && !resourceAllowed(target.oauth.resource, target.url))
      throw new McpTargetError(
        "the connection's authorisation names a resource this server may not speak for (press Authorise on its card); nothing was called",
      );
    const store = deps.secrets;
    if (!store)
      throw new McpTargetError("the board has no secret store, so an OAuth connection cannot be called");
    const data = await store.get(target.oauth.secretName);
    if (!data?.access_token)
      throw new McpTargetError(
        "the connection is not authorised (press Authorise on its card); nothing was called",
      );
    const now = deps.now?.() ?? Date.now();
    if (!isExpiring(data.expires_at, now)) return data.access_token;
    if (
      !data.refresh_token ||
      !target.oauth.tokenEndpoint ||
      !target.oauth.clientId ||
      !target.oauth.resource
    )
      throw new McpTargetError(
        "the connection's authorisation has expired (press Authorise on its card); nothing was called",
      );
    // The client secret: the store's when the board registered itself, else the named env var's.
    const secretName = target.oauth.clientSecretEnvName;
    const namedSecret = secretName ? (deps.env?.[secretName] ?? null) : null;
    if (secretName && !namedSecret)
      throw new McpTargetError(`${notSetForCompany(secretName)}; nothing was called`);
    const set = await refreshTokens(
      target.oauth.tokenEndpoint,
      {
        clientId: target.oauth.clientId,
        clientSecret: data.client_secret ?? namedSecret,
        tokenAuth: target.oauth.tokenAuth,
        refreshToken: data.refresh_token,
        resource: target.oauth.resource,
      },
      {
        egress: deps.egress ?? defaultEgress(),
        ...(deps.now ? { now: deps.now } : {}),
        log: deps.log ?? { warn: () => undefined },
      },
    ).catch((err: Error) => {
      throw new McpTargetError(`${err.message}; authorise the connection again`);
    });
    const next: Record<string, string> = { access_token: set.accessToken };
    if (data.client_secret) next.client_secret = data.client_secret;
    if (set.refreshToken) next.refresh_token = set.refreshToken;
    if (set.expiresAt) next.expires_at = set.expiresAt;
    await store.put(target.oauth.secretName, next);
    return set.accessToken;
  }
  if (!target.authEnvName) return null;
  const v = deps.env?.[target.authEnvName];
  return v && v.trim() ? v.trim() : null;
}

function buildTransport(target: McpTarget, deps: McpClientDeps, secret: string | null): Transport {
  const env = deps.env ?? {};
  if (target.transport === "http") {
    if (!target.url) throw new McpTargetError("the connection has no URL");
    if (target.authEnvName && !secret)
      throw new McpTargetError(`${notSetForCompany(target.authEnvName)}; nothing was called`);
    if (target.oauth && !secret)
      throw new McpTargetError("the connection is not authorised; nothing was called");
    // A redirect is followed only on the server's own origin (/mcp to /mcp/, http to https), checked again:
    // the bearer and the call never go to another server. The answer may be an event stream, so the deadline
    // stops at its headers and the call's own timeout and the client's close end the rest.
    return new StreamableHTTPClientTransport(new URL(target.url), {
      fetch: egressFetch(deps.egress ?? defaultEgress(), {
        redirect: "same-origin",
        timeoutMs: deps.timeoutMs ?? MCP_CALL_TIMEOUT_MS,
        stream: true,
        maxBytes: MCP_ANSWER_MAX_BYTES,
        budget: readBudget(MCP_CALL_MAX_BYTES, MCP_CALL_MAX_REQUESTS),
      }),
      requestInit: secret ? { headers: { authorization: `Bearer ${secret}` } } : {},
    });
  }
  if (!target.command) throw new McpTargetError("the connection has no command");
  // The child runs inside the board, as the board: only what the operator listed, whatever the row says.
  const refusal = stdioRefusal(deps.stdioCommands ?? [], target.command, target.args);
  if (refusal) throw new McpTargetError(`${refusal}; nothing was started`);
  const childEnv: Record<string, string> = { ...getDefaultEnvironment() };
  for (const name of [...(target.envNames ?? []), ...(target.authEnvName ? [target.authEnvName] : [])]) {
    const v = env[name];
    if (v === undefined) throw new McpTargetError(`${notSetForCompany(name)}; nothing was called`);
    childEnv[name] = v;
  }
  return new StdioClientTransport({
    command: target.command,
    args: target.args ?? [],
    env: childEnv,
    stderr: "ignore",
  });
}

/**
 * Connect, run `fn`, close (or, for a pooled stdio child, keep it for the next
 * call and close it only when a call fails). Errors come back scrubbed of the
 * credential value.
 */
export async function withMcpClient<T>(
  target: McpTarget,
  deps: McpClientDeps,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const env = deps.env ?? {};
  const secret = await resolveCredential(target, deps);
  const secrets = [secret, ...(target.envNames ?? []).map((n) => env[n] ?? null)].filter(
    (s): s is string => !!s,
  );
  const timeout = deps.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const connect = async (watch?: (client: Client) => void): Promise<Client> => {
    const client = new Client({ name: "rosterdock-board", version: "0.5.0" });
    watch?.(client);
    let transport: Transport;
    try {
      transport = buildTransport(target, deps, secret);
    } catch (err) {
      if (err instanceof McpTargetError) throw err;
      throw new Error(scrub((err as Error).message, secrets));
    }
    await client.connect(transport, { timeout });
    return client;
  };
  const pool = target.transport === "stdio" ? deps.pool : undefined;
  if (pool) {
    const key = poolKey(target, deps.poolScope ?? "", env);
    let client: Client;
    try {
      client = await pool.acquire(key, connect);
    } catch (err) {
      if (err instanceof McpTargetError) throw err;
      throw new Error(scrub((err as Error).message ?? String(err), secrets));
    }
    try {
      return await fn(client);
    } catch (err) {
      await pool.evict(key, client);
      throw new Error(scrub((err as Error).message ?? String(err), secrets));
    }
  }
  // An answer cut at its cap inside an event stream reaches the SDK's onerror, not the call waiting on it,
  // which would otherwise wait out its timeout: the call ends with the cut, from initialize on. The client
  // closes at once, so the SDK does not resume the stream: each resume would be a new answer, cut afresh.
  let cut: (err: Error) => void = () => {};
  const tooBig = new Promise<never>((_, reject) => (cut = reject));
  tooBig.catch(() => {});
  const watch = (c: Client) => {
    c.onerror = (err) => {
      if (!err.message.includes(READ_NO_FURTHER)) return;
      // Without the SDK's own words in front ("SSE stream disconnected: Error: ...").
      cut(new Error(err.message.replace(/^(?:[A-Za-z ]+: )*(?:Error: )?/, "")));
      void c.close().catch(() => {});
    };
  };
  let client: Client | null = null;
  try {
    client = await Promise.race([connect(watch), tooBig]);
    return await Promise.race([fn(client), tooBig]);
  } catch (err) {
    if (err instanceof McpTargetError) throw err;
    throw new Error(scrub((err as Error).message ?? String(err), secrets));
  } finally {
    await client?.close().catch(() => {});
  }
}

/** tools/list, with the annotations a server sends. */
export async function discoverTools(target: McpTarget, deps: McpClientDeps = {}): Promise<DiscoveredTool[]> {
  return withMcpClient(target, deps, async (client) => {
    const out: DiscoveredTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: deps.timeoutMs ?? MCP_CALL_TIMEOUT_MS,
      });
      for (const t of page.tools) {
        out.push({
          name: t.name,
          description: (t.description ?? "").slice(0, 2000),
          annotations: t.annotations
            ? { readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint }
            : null,
          inputSchema: t.inputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  });
}

/** tools/call with exactly these arguments. The result is the structured content when there is one, else the text. */
export async function callMcpTool(
  target: McpTarget,
  deps: McpClientDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallOutcome> {
  try {
    return await withMcpClient(target, deps, async (client) => {
      const res = (await client.callTool({ name, arguments: args }, undefined, {
        timeout: deps.timeoutMs ?? MCP_CALL_TIMEOUT_MS,
      })) as {
        content?: { type: string; text?: string }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n")
        .slice(0, MCP_RESULT_MAX_CHARS);
      if (res.isError) return { ok: false, error: text || `${name} returned an error` };
      return { ok: true, result: res.structuredContent ?? parseMaybeJson(text) };
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 2000) };
  }
}

function parseMaybeJson(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}
