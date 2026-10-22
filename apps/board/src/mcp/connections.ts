// Connections: the external systems a company can reach, one row each, with
// the tools discovered on them and whether each tool writes. Credentials are
// env var NAMES. Owners and admins add, discover, reclassify and remove;
// teammates only ever reach a connection through the broker. A stdio
// connection's command runs inside the board, so it must be a command line the
// operator lists (ROSTERDOCK_STDIO_COMMANDS), checked when it is written and again
// before anything starts. The web connection is the board's own fetch: no URL,
// command or credential, one tool that reads, and the company's list of web
// domains in its manifest.

import {
  classifyTool,
  domainList,
  type ActorRef,
  type StdioCommand,
  type ConnectionOAuthInput,
  type ConnectionToolInput,
  type CreateConnectionInput,
  type CreateOpenApiConnectionInput,
  type UpdateConnectionInput,
} from "@rosterdock/shared";
import type { Db, Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import { assertStdioCommand } from "../operator.js";
import { withCompanyEnv } from "../secrets/company.js";
import { connectionSecretName, type SecretStore } from "../secrets/store.js";
import { catalogEntry } from "./catalog.js";
import { discoverTools, type McpClientDeps, type McpTarget } from "./client.js";
import type { TokenAuth } from "./oauth.js";
import { buildOpenApiManifest, probeOpenApi, toolsFromManifest, type OpenApiManifest } from "./openapi.js";
import { WEB_FETCH_TOOL, WEB_TOOLS } from "../web/read.js";

export type ConnectionTool = ConnectionToolInput;

/** The outcome of the last health check, kept on the row for the Settings page. */
export interface ConnectionCheck {
  ok: boolean;
  at: string;
  latencyMs: number;
  error: string | null;
  /** What the system lists against what the row knows (MCP); the manifest's operations (OpenAPI). */
  tools: { seen: number; missing: string[]; extra: string[] };
}

/** What the row keeps about an OAuth authorisation: nothing secret. The tokens are in the store under the connection's name. */
export interface ConnectionOAuth {
  /** The issuer, once discovered (null until the first start). */
  authorizationServer: string | null;
  tokenEndpoint: string | null;
  /** Given by a person, or registered by the board at the first start. */
  clientId: string | null;
  /** With a given client id: the env var NAME its secret lives under where the board runs. */
  clientSecretEnvName?: string | null;
  registered: boolean;
  scopes: string[];
  authorizedAt: string | null;
  /** What the server calls itself in its protected resource metadata (RFC 8707); null or absent: the MCP URL. */
  resource?: string | null;
  /** How the secret reaches the token endpoint, from the server's metadata at the last start; absent: basic. */
  tokenAuth?: TokenAuth | null;
}

export function oauthFrom(input: ConnectionOAuthInput): ConnectionOAuth {
  return {
    authorizationServer: null,
    tokenEndpoint: null,
    clientId: input.clientId ?? null,
    clientSecretEnvName: input.clientSecretEnvName ?? null,
    registered: false,
    scopes: input.scopes ?? [],
    authorizedAt: null,
    resource: null,
    tokenAuth: null,
  };
}

/** The resource identifier the authorization server expects: the one the server declared, else the MCP URL. */
export function oauthResource(row: Pick<ConnectionRow, "url" | "oauth">): string | null {
  return row.oauth?.resource ?? row.url;
}

export interface ConnectionRow {
  id: string;
  company_id: string;
  name: string;
  catalog_id: string | null;
  kind: "mcp" | "openapi" | "web";
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  auth_env_name: string | null;
  env_names: string[];
  enabled: boolean;
  tools: ConnectionTool[];
  manifest: Record<string, unknown> | null;
  discovered_at: Date | null;
  last_check: ConnectionCheck | null;
  oauth: ConnectionOAuth | null;
  created_at: Date;
  updated_at: Date;
}

export function connectionToJson(row: ConnectionRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    catalogId: row.catalog_id,
    kind: row.kind,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args ?? [],
    authEnvName: row.auth_env_name,
    envNames: row.env_names ?? [],
    enabled: row.enabled,
    tools: row.tools ?? [],
    manifest: row.manifest,
    discoveredAt: row.discovered_at?.toISOString() ?? null,
    lastCheck: row.last_check ?? null,
    oauth: row.oauth
      ? {
          authorizationServer: row.oauth.authorizationServer,
          clientId: row.oauth.clientId,
          clientSecretEnvName: row.oauth.clientSecretEnvName ?? null,
          registered: row.oauth.registered,
          scopes: row.oauth.scopes,
          authorizedAt: row.oauth.authorizedAt,
        }
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function targetFor(row: ConnectionRow): McpTarget {
  return {
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args ?? [],
    authEnvName: row.auth_env_name,
    envNames: row.env_names ?? [],
    oauth: row.oauth
      ? {
          secretName: connectionSecretName(row.id),
          tokenEndpoint: row.oauth.tokenEndpoint,
          clientId: row.oauth.clientId,
          clientSecretEnvName: row.oauth.clientSecretEnvName ?? null,
          resource: oauthResource(row),
          tokenAuth: row.oauth.tokenAuth ?? null,
        }
      : null,
  };
}

export async function listConnections(db: Queryable, companyId: string): Promise<ConnectionRow[]> {
  const res = await db.query<ConnectionRow>(
    "SELECT * FROM connections WHERE company_id = $1 ORDER BY created_at",
    [companyId],
  );
  return res.rows;
}

export async function loadConnection(db: Queryable, companyId: string, id: string): Promise<ConnectionRow> {
  const res = await db.query<ConnectionRow>("SELECT * FROM connections WHERE id = $1 AND company_id = $2", [
    id,
    companyId,
  ]);
  const row = res.rows[0];
  if (!row) throw notFound("connection");
  return row;
}

export async function connectionByName(
  db: Queryable,
  companyId: string,
  name: string,
): Promise<ConnectionRow | null> {
  const res = await db.query<ConnectionRow>("SELECT * FROM connections WHERE company_id = $1 AND name = $2", [
    companyId,
    name,
  ]);
  return res.rows[0] ?? null;
}

/** The web connection's manifest: the company's list of web domains, or null for any public site. */
export function webManifest(domains: readonly string[] | null | undefined): { domains: string[] | null } {
  return { domains: domainList(domains) };
}

function assertReachable(
  row: Pick<ConnectionRow, "kind" | "transport" | "url" | "command"> & {
    oauth?: ConnectionOAuth | null;
    auth_env_name?: string | null;
  },
): void {
  if (row.kind === "web") {
    if (row.url || row.command || row.oauth || row.auth_env_name)
      throw new HttpError(
        422,
        "the web connection is the board's own: it takes no URL, command or credential",
      );
    return;
  }
  if (row.oauth) {
    if (row.kind !== "mcp" || row.transport !== "http" || !row.url)
      throw new HttpError(422, "OAuth is for MCP servers over HTTP");
    if (row.auth_env_name) throw new HttpError(422, "a credential by name or OAuth, not both");
  }
  if (row.kind === "openapi") {
    if (!row.url) throw new HttpError(422, "an OpenAPI connection needs a base URL");
    return;
  }
  if (row.transport === "http" && !row.url) throw new HttpError(422, "an HTTP connection needs a URL");
  if (row.transport === "stdio" && !row.command)
    throw new HttpError(422, "a stdio connection needs a command");
}

/** Tools a fresh connection starts with: the catalog's known reads and writes, until discovery. */
function seedTools(catalogId: string | null, given: ConnectionTool[] | undefined): ConnectionTool[] {
  if (given?.length) return given;
  const entry = catalogEntry(catalogId);
  if (!entry) return [];
  return [
    ...entry.reads.map((name) => ({ name, description: "", write: false, source: "catalog" as const })),
    ...entry.writes.map((name) => ({ name, description: "", write: true, source: "catalog" as const })),
  ];
}

export async function createConnection(
  db: Db,
  companyId: string,
  actor: ActorRef,
  input: CreateConnectionInput,
  /** The command lines the board runs for a stdio connection (ROSTERDOCK_STDIO_COMMANDS). */
  stdioCommands: readonly StdioCommand[] = [],
): Promise<ConnectionRow> {
  const entry = catalogEntry(input.catalogId);
  const kind = input.kind ?? entry?.kind ?? "mcp";
  const transport = kind === "web" ? "http" : (input.transport ?? entry?.transport ?? "http");
  const oauth = input.oauth ? oauthFrom(input.oauth) : null;
  assertReachable({
    kind,
    transport,
    url: input.url ?? null,
    command: input.command ?? null,
    oauth,
    auth_env_name: input.authEnvName ?? null,
  });
  if (kind !== "web" && input.domains?.length)
    throw new HttpError(422, "only the web connection keeps a list of web domains");
  if (kind === "mcp" && transport === "stdio") assertStdioCommand(stdioCommands, input.command, input.args);
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const dup = await ctx.client.query("SELECT 1 FROM connections WHERE company_id = $1 AND name = $2", [
      companyId,
      input.name,
    ]);
    if (dup.rowCount) throw new HttpError(409, `a connection named ${input.name} already exists`);
    if (kind === "web") {
      const web = await ctx.client.query<{ name: string }>(
        "SELECT name FROM connections WHERE company_id = $1 AND kind = 'web'",
        [companyId],
      );
      if (web.rowCount)
        throw new HttpError(409, `this company has its web connection already: ${web.rows[0]!.name}`);
    }
    const row = (
      await ctx.client.query<ConnectionRow>(
        `INSERT INTO connections (company_id, name, catalog_id, kind, transport, url, command, args, auth_env_name, env_names, enabled, tools, oauth, manifest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [
          companyId,
          input.name,
          input.catalogId ?? null,
          kind,
          transport,
          input.url ?? null,
          input.command ?? null,
          JSON.stringify(input.args ?? []),
          input.authEnvName ?? null,
          JSON.stringify(input.envNames ?? []),
          input.enabled ?? true,
          JSON.stringify(
            // The web connection's tools are the board's, whatever the request says.
            kind === "web"
              ? WEB_TOOLS
              : seedTools(
                  input.catalogId ?? null,
                  input.tools?.map((t) => ({
                    name: t.name,
                    description: t.description ?? "",
                    write: t.write,
                    source: t.source ?? "default",
                  })),
                ),
          ),
          oauth ? JSON.stringify(oauth) : null,
          kind === "web" ? JSON.stringify(webManifest(input.domains)) : null,
        ],
      )
    ).rows[0]!;
    await ctx.emit(
      "connection.created",
      { kind: "connection", id: row.id },
      {
        name: row.name,
        kind: row.kind,
        transport: row.transport,
        catalogId: row.catalog_id,
        authEnvName: row.auth_env_name,
        oauth: !!row.oauth,
        tools: row.tools.length,
        ...(kind === "web" ? { domains: webManifest(input.domains).domains } : {}),
      },
    );
    return row;
  });
  return result;
}

/** An OpenAPI connection from a spec and an allowlist: the manifest is the registration, its operations the tools. */
export async function createOpenApiConnection(
  db: Db,
  companyId: string,
  actor: ActorRef,
  input: CreateOpenApiConnectionInput,
): Promise<ConnectionRow> {
  const built = buildOpenApiManifest(input.spec, {
    allow: input.allow,
    writes: input.writes,
    authHeader: input.authHeader,
    authScheme: input.authScheme,
    timeoutMs: input.timeoutMs,
    maxRequestBytes: input.maxRequestBytes,
    maxResponseBytes: input.maxResponseBytes,
  });
  if (!built.manifest) throw new HttpError(422, `the spec cannot be registered: ${built.errors.join("; ")}`);
  const manifest = built.manifest;
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const dup = await ctx.client.query("SELECT 1 FROM connections WHERE company_id = $1 AND name = $2", [
      companyId,
      input.name,
    ]);
    if (dup.rowCount) throw new HttpError(409, `a connection named ${input.name} already exists`);
    const row = (
      await ctx.client.query<ConnectionRow>(
        `INSERT INTO connections (company_id, name, kind, transport, url, auth_env_name, enabled, tools, manifest, discovered_at)
         VALUES ($1, $2, 'openapi', 'http', $3, $4, $5, $6, $7, now()) RETURNING *`,
        [
          companyId,
          input.name,
          input.url,
          input.authEnvName ?? null,
          input.enabled ?? true,
          JSON.stringify(toolsFromManifest(manifest)),
          JSON.stringify(manifest),
        ],
      )
    ).rows[0]!;
    await ctx.emit(
      "connection.created",
      { kind: "connection", id: row.id },
      {
        name: row.name,
        kind: row.kind,
        transport: row.transport,
        catalogId: null,
        authEnvName: row.auth_env_name,
        tools: row.tools.length,
        writes: row.tools.filter((t) => t.write).map((t) => t.name),
      },
    );
    return row;
  });
  return result;
}

export async function updateConnection(
  db: Db,
  companyId: string,
  actor: ActorRef,
  id: string,
  input: UpdateConnectionInput,
  store: SecretStore | null = null,
  /** The command lines the board runs for a stdio connection; checked when the command or its arguments change. */
  stdioCommands: readonly StdioCommand[] = [],
): Promise<ConnectionRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const row = (
      await ctx.client.query<ConnectionRow>(
        "SELECT * FROM connections WHERE id = $1 AND company_id = $2 FOR UPDATE",
        [id, companyId],
      )
    ).rows[0];
    if (!row) throw notFound("connection");
    if (input.domains !== undefined && row.kind !== "web")
      throw new HttpError(422, "only the web connection keeps a list of web domains");
    if (row.kind === "web" && input.tools?.some((t) => t.write === true || t.name !== WEB_FETCH_TOOL))
      throw new HttpError(422, `${row.name} has one tool, ${WEB_FETCH_TOOL}, and it only reads`);
    const manifest =
      row.kind === "web" && input.domains !== undefined ? webManifest(input.domains) : row.manifest;
    // A change of authorisation starts over: whatever tokens the store held for it go first.
    const oauth = input.oauth === undefined ? row.oauth : input.oauth ? oauthFrom(input.oauth) : null;
    if (input.oauth !== undefined && row.oauth) await store?.delete(connectionSecretName(id));
    const next = {
      url: input.url !== undefined ? input.url : row.url,
      command: input.command !== undefined ? input.command : row.command,
      args: input.args ?? row.args ?? [],
      auth_env_name: input.authEnvName !== undefined ? input.authEnvName : row.auth_env_name,
      env_names: input.envNames ?? row.env_names ?? [],
      enabled: input.enabled ?? row.enabled,
      oauth,
    };
    assertReachable({ kind: row.kind, transport: row.transport, ...next });
    if (
      row.kind === "mcp" &&
      row.transport === "stdio" &&
      (input.command !== undefined || input.args !== undefined)
    )
      assertStdioCommand(stdioCommands, next.command, next.args);
    // A person's classification is recorded as theirs and survives the next discovery; so does a tool
    // they switched off, which stays classified by whatever classified it. A tool held as a write because
    // only the server called it read-only becomes a read here once a person confirms it.
    let tools = row.tools ?? [];
    const reclassified: string[] = [];
    const confirmed: string[] = [];
    const switchedOff: string[] = [];
    const switchedOn: string[] = [];
    if (input.tools) {
      for (const t of input.tools) {
        const existing = tools.find((x) => x.name === t.name);
        if (t.off !== undefined && (existing?.off ?? false) !== t.off)
          (t.off ? switchedOff : switchedOn).push(t.name);
        if (existing) {
          if (t.write !== undefined && (existing.write !== t.write || existing.source !== "person"))
            reclassified.push(t.name);
          if (t.write === false && existing.source === "unconfirmed") confirmed.push(t.name);
          tools = tools.map((x) =>
            x.name === t.name
              ? {
                  ...x,
                  ...(t.write !== undefined ? { write: t.write, source: "person" as const } : {}),
                  ...(t.off !== undefined ? { off: t.off } : {}),
                }
              : x,
          );
        } else {
          if (t.write === undefined)
            throw new HttpError(422, `${t.name} is not a tool on this connection; discover first`);
          tools = [
            ...tools,
            { name: t.name, description: "", write: t.write, source: "person" as const, off: t.off ?? false },
          ];
          reclassified.push(t.name);
        }
      }
    }
    const updated = (
      await ctx.client.query<ConnectionRow>(
        `UPDATE connections SET url = $3, command = $4, args = $5, auth_env_name = $6, env_names = $7, enabled = $8, tools = $9, oauth = $10, manifest = $11, updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING *`,
        [
          id,
          companyId,
          next.url,
          next.command,
          JSON.stringify(next.args),
          next.auth_env_name,
          JSON.stringify(next.env_names),
          next.enabled,
          JSON.stringify(tools),
          next.oauth ? JSON.stringify(next.oauth) : null,
          manifest ? JSON.stringify(manifest) : null,
        ],
      )
    ).rows[0]!;
    await ctx.emit(
      "connection.updated",
      { kind: "connection", id },
      {
        name: updated.name,
        changes: Object.keys(input),
        enabled: updated.enabled,
        reclassified,
        confirmed,
        switchedOff,
        switchedOn,
        writes: tools.filter((t) => t.write).map((t) => t.name),
        off: tools.filter((t) => t.off).map((t) => t.name),
        ...(row.kind === "web" && input.domains !== undefined
          ? { domains: (manifest as { domains: string[] | null }).domains }
          : {}),
      },
    );
    return updated;
  });
  return result;
}

export async function deleteConnection(
  db: Db,
  companyId: string,
  actor: ActorRef,
  id: string,
  store: SecretStore | null = null,
): Promise<void> {
  await mutate(db, companyId, actor, async (ctx) => {
    const pending = await ctx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM approvals WHERE connection_id = $1 AND status = 'pending'",
      [id],
    );
    if ((pending.rows[0]?.n ?? 0) > 0)
      throw new HttpError(409, "decide the pending approvals on this connection first");
    // The tokens first, then the row: a store that refuses leaves the connection as it was.
    const had = await ctx.client.query<{ oauth: unknown }>(
      "SELECT oauth FROM connections WHERE id = $1 AND company_id = $2",
      [id, companyId],
    );
    if (had.rows[0]?.oauth) await store?.delete(connectionSecretName(id));
    const res = await ctx.client.query<{ name: string }>(
      "DELETE FROM connections WHERE id = $1 AND company_id = $2 RETURNING name",
      [id, companyId],
    );
    const row = res.rows[0];
    if (!row) throw notFound("connection");
    await ctx.emit("connection.deleted", { kind: "connection", id }, { name: row.name });
  });
}

/**
 * tools/list against the live server. Each tool is classified from its
 * annotations, the catalog and its name (a read-only label alone holds it as a
 * write for a person to confirm); a classification a person set earlier for a
 * tool of the same name is kept. Replaces the stored tools.
 */
export async function discoverConnectionTools(
  db: Db,
  companyId: string,
  actor: ActorRef,
  id: string,
  boardDeps: McpClientDeps,
): Promise<ConnectionRow> {
  const row = await loadConnection(db, companyId, id);
  const deps = await withCompanyEnv(boardDeps, companyId);
  if (row.kind === "web")
    throw new HttpError(
      422,
      `${row.name} is the board's own: its one tool is ${WEB_FETCH_TOOL}, nothing to discover`,
    );
  if (row.kind !== "mcp")
    throw new HttpError(422, "only MCP connections discover tools; OpenAPI ones carry a manifest");
  if (row.transport === "stdio") assertStdioCommand(deps.stdioCommands ?? [], row.command, row.args);
  const entry = catalogEntry(row.catalog_id);
  const found = await discoverTools(targetFor(row), deps);
  const before = new Map((row.tools ?? []).map((t) => [t.name, t]));
  const tools: ConnectionTool[] = found.map((t) => {
    const prior = before.get(t.name);
    if (prior?.source === "person") return { ...prior, description: t.description };
    const c = classifyTool(t.name, {
      annotations: t.annotations,
      catalog: entry ? { reads: entry.reads, writes: entry.writes } : null,
    });
    return {
      name: t.name,
      description: t.description,
      write: c.write,
      source: c.source,
      ...(prior?.off ? { off: true } : {}),
    };
  });
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const updated = (
      await ctx.client.query<ConnectionRow>(
        "UPDATE connections SET tools = $3, discovered_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *",
        [id, companyId, JSON.stringify(tools)],
      )
    ).rows[0]!;
    await ctx.emit(
      "connection.updated",
      { kind: "connection", id },
      {
        name: updated.name,
        changes: ["tools"],
        discovered: tools.length,
        reads: tools.filter((t) => !t.write).map((t) => t.name),
        writes: tools.filter((t) => t.write).map((t) => t.name),
        // Held for a person to confirm as reads; one switched off waits for nothing.
        unconfirmed: tools.filter((t) => t.source === "unconfirmed" && !t.off).map((t) => t.name),
      },
    );
    return updated;
  });
  return result;
}

/**
 * A health check from Settings: does the system answer, with this credential,
 * and does it still list what the row knows? MCP: a tools/list, compared by
 * name. OpenAPI: one GET on the base URL. The outcome lands on the row and in
 * one event; nothing about the credential does.
 */
export async function checkConnection(
  db: Db,
  companyId: string,
  actor: ActorRef,
  id: string,
  boardDeps: McpClientDeps,
): Promise<ConnectionRow> {
  const row = await loadConnection(db, companyId, id);
  const deps = await withCompanyEnv(boardDeps, companyId);
  const started = Date.now();
  const known = (row.tools ?? []).map((t) => t.name);
  const none = { seen: 0, missing: [] as string[], extra: [] as string[] };
  let check: ConnectionCheck;
  if (row.kind === "web") {
    // Nothing to ask: the board reads the web itself, or its operator keeps it off the web.
    check = {
      ok: !!deps.web,
      at: "",
      latencyMs: 0,
      error: deps.web
        ? null
        : "this board is kept off the web by its operator (ROSTERDOCK_FETCH_SOURCES=0); it fetches nothing",
      tools: { seen: WEB_TOOLS.length, missing: [], extra: [] },
    };
  } else if (row.kind === "openapi") {
    const manifest = row.manifest as unknown as OpenApiManifest | null;
    if (!row.url || !manifest) {
      check = { ok: false, at: "", latencyMs: 0, error: "the connection has no manifest", tools: none };
    } else {
      const probe = await probeOpenApi({ url: row.url, authEnvName: row.auth_env_name }, manifest, {
        ...(deps.egress ? { egress: deps.egress } : {}),
        ...(deps.env ? { env: deps.env } : {}),
      });
      check = {
        ok: probe.ok,
        at: "",
        latencyMs: 0,
        error: probe.error,
        tools: { seen: manifest.operations.length, missing: [], extra: [] },
      };
    }
  } else {
    try {
      const found = await discoverTools(targetFor(row), deps);
      const seen = found.map((t) => t.name);
      check = {
        ok: true,
        at: "",
        latencyMs: 0,
        error: null,
        tools: {
          seen: seen.length,
          missing: known.filter((n) => !seen.includes(n)),
          extra: seen.filter((n) => !known.includes(n)),
        },
      };
    } catch (err) {
      check = { ok: false, at: "", latencyMs: 0, error: (err as Error).message.slice(0, 300), tools: none };
    }
  }
  check.at = new Date().toISOString();
  check.latencyMs = Date.now() - started;
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const updated = (
      await ctx.client.query<ConnectionRow>(
        "UPDATE connections SET last_check = $3, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *",
        [id, companyId, JSON.stringify(check)],
      )
    ).rows[0]!;
    await ctx.emit(
      "connection.checked",
      { kind: "connection", id },
      {
        name: updated.name,
        kind: updated.kind,
        ok: check.ok,
        latencyMs: check.latencyMs,
        error: check.error,
        seen: check.tools.seen,
        missing: check.tools.missing,
        extra: check.tools.extra,
      },
    );
    return updated;
  });
  return result;
}
