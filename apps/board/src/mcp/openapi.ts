// The OpenAPI runtime: one shared runtime turns a parsed OpenAPI 3.x document
// plus an allowlist into a connection whose tools are HTTP operations. No code
// is generated per service; the manifest is the registration and everything
// risky is enforced here: only manifest operations exist, a mutating method is
// always a write, request and response sizes and time are capped, the
// credential is an env var NAME resolved at call time (from `deps.env`: a
// company's secrets over the names the board shares), a request reaches only a
// public address or a private one the operator lists and follows no redirect
// (web/egress.ts), and answers come back
// with secret-shaped keys redacted. Carried over from the v1 prototype without
// its governance ladder; the broker decides, this module calls.

import {
  trimTrailingSlashes,
  type ConnectionToolInput,
  type OpenApiManifestInput,
  type OpenApiOperationInput,
} from "@rosterdock/shared";
import YAML from "yaml";
import { notSetForCompany } from "../secrets/company.js";
import { defaultEgress, egressFetch, readCapped, type Egress } from "../web/egress.js";
import type { McpCallOutcome } from "./client.js";
import { scrubber, scrubText, type Scrubber } from "./scrub.js";

export type OpenApiManifest = OpenApiManifestInput;
export type OpenApiOperation = OpenApiOperationInput;
export type OpenApiMethod = OpenApiOperation["method"];

const METHODS: OpenApiMethod[] = ["get", "head", "post", "put", "patch", "delete"];
const READ_METHODS = new Set<OpenApiMethod>(["get", "head"]);
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,127}$/;

/** operationId to the tool name teammates use: camelCase and punctuation become snake_case. */
export function toolNameFor(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * A spec as text: JSON first (exact errors), then YAML (a YAML 1.2 parser reads
 * JSON too, but the error messages are worse). Aliases are capped so a small
 * document cannot expand into a large one. Anything but an object is refused.
 */
export function parseOpenApiText(text: string): {
  spec: Record<string, unknown> | null;
  error: string | null;
} {
  const trimmed = text.trim();
  if (!trimmed) return { spec: null, error: "the spec is empty" };
  let value: unknown;
  if (trimmed.startsWith("{")) {
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      return { spec: null, error: `the spec is not valid JSON: ${(err as Error).message.slice(0, 200)}` };
    }
  } else {
    try {
      value = YAML.parse(trimmed, { maxAliasCount: 100, uniqueKeys: true, strict: true });
    } catch (err) {
      return { spec: null, error: `the spec is not valid YAML: ${(err as Error).message.slice(0, 200)}` };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { spec: null, error: "the spec must be an OpenAPI 3.x document (an object)" };
  return { spec: value as Record<string, unknown>, error: null };
}

/** A parsed object as given, or text parsed as JSON or YAML. */
export function specObject(spec: string | Record<string, unknown>): {
  spec: Record<string, unknown> | null;
  error: string | null;
} {
  return typeof spec === "string" ? parseOpenApiText(spec) : { spec, error: null };
}

export interface ScannedOperation {
  operationId: string;
  name: string;
  method: OpenApiMethod;
  path: string;
  summary: string;
  /** From the method: GET and HEAD read, everything else writes. An override can only make a read a write. */
  write: boolean;
}

/** Every operation with an operationId in a parsed OpenAPI 3.x document. */
export function scanOpenApi(spec: unknown): { operations: ScannedOperation[]; errors: string[] } {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    return {
      operations: [],
      errors: ["the spec must be an OpenAPI 3.x document: a parsed object, or JSON or YAML text"],
    };
  const doc = spec as Record<string, unknown>;
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3."))
    return { operations: [], errors: ['the spec needs an "openapi": "3.x" version'] };
  if (!doc.paths || typeof doc.paths !== "object" || Array.isArray(doc.paths))
    return { operations: [], errors: ["the spec has no paths object"] };
  const operations: ScannedOperation[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths as Record<string, unknown>)) {
    if (!path.startsWith("/") || !item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const op = (item as Record<string, unknown>)[method];
      if (!op || typeof op !== "object") continue;
      const operationId = (op as Record<string, unknown>).operationId;
      if (typeof operationId !== "string" || !operationId) continue;
      if (seen.has(operationId)) {
        errors.push(`the spec reuses operationId ${operationId}`);
        continue;
      }
      seen.add(operationId);
      const summary = (op as Record<string, unknown>).summary;
      operations.push({
        operationId,
        name: toolNameFor(operationId),
        method,
        path,
        summary: typeof summary === "string" ? summary.slice(0, 200) : "",
        write: !READ_METHODS.has(method),
      });
    }
  }
  if (!operations.length) errors.push("the spec has no operations with an operationId");
  return { operations, errors };
}

export interface BuildManifestOptions {
  /** operationIds to expose. Nothing else exists on the connection. */
  allow: string[];
  /** operationIds to treat as writes even though their method reads. Never the other way. */
  writes?: string[];
  authHeader?: string;
  authScheme?: "bearer" | "header";
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export const OPENAPI_LIMITS = {
  timeoutMs: { default: 15_000, max: 30_000 },
  maxRequestBytes: { default: 64 * 1024, max: 256 * 1024 },
  maxResponseBytes: { default: 256 * 1024, max: 512 * 1024 },
};

export function buildOpenApiManifest(
  spec: unknown,
  opts: BuildManifestOptions,
): { manifest: OpenApiManifest | null; errors: string[] } {
  const scan = scanOpenApi(spec);
  const errors = [...scan.errors];
  if (!scan.operations.length) return { manifest: null, errors };
  const byId = new Map(scan.operations.map((o) => [o.operationId, o]));
  const forcedWrites = new Set(opts.writes ?? []);
  const operations: OpenApiOperation[] = [];
  const names = new Set<string>();
  for (const id of [...new Set(opts.allow)]) {
    const found = byId.get(id);
    if (!found) {
      errors.push(`operationId ${id} is not in the spec`);
      continue;
    }
    if (!TOOL_NAME_RE.test(found.name)) {
      errors.push(`operationId ${id} does not make a usable tool name`);
      continue;
    }
    if (names.has(found.name)) {
      errors.push(`two allowed operations map to the tool name ${found.name}`);
      continue;
    }
    names.add(found.name);
    operations.push({
      name: found.name,
      operationId: id,
      method: found.method,
      path: found.path,
      write: found.write || forcedWrites.has(id),
      summary: found.summary,
    });
  }
  for (const id of forcedWrites)
    if (!byId.has(id)) errors.push(`operationId ${id} (a forced write) is not in the spec`);
  if (!operations.length) errors.push("no allowed operation survived");
  const clamp = (v: number | undefined, lim: { default: number; max: number }) =>
    Math.min(Math.max(1, Math.floor(v ?? lim.default)), lim.max);
  const manifest: OpenApiManifest = {
    ...(opts.authHeader ? { authHeader: opts.authHeader } : {}),
    authScheme: opts.authScheme ?? "bearer",
    timeoutMs: clamp(opts.timeoutMs, OPENAPI_LIMITS.timeoutMs),
    maxRequestBytes: clamp(opts.maxRequestBytes, OPENAPI_LIMITS.maxRequestBytes),
    maxResponseBytes: clamp(opts.maxResponseBytes, OPENAPI_LIMITS.maxResponseBytes),
    operations,
  };
  return { manifest: errors.length ? null : manifest, errors };
}

/** The connection's tools as the broker and the pack see them. */
export function toolsFromManifest(manifest: OpenApiManifest): ConnectionToolInput[] {
  return manifest.operations.map((o) => ({
    name: o.name,
    description: `${o.method.toUpperCase()} ${o.path}${o.summary ? ` · ${o.summary}` : ""}`,
    write: o.write,
    source: "method" as const,
  }));
}

export interface OpenApiTarget {
  /** The base URL; operation paths are appended. */
  url: string;
  authEnvName?: string | null;
}

/** A check reads no body; this bounds what is pulled before the body is dropped. */
const PROBE_MAX_BYTES = 64 * 1024;

export interface OpenApiDeps {
  /** How the service is reached (web/egress.ts); tests inject its transport and resolver. Default: the board's own. */
  egress?: Egress;
  /** Where the credential's NAME resolves: a company's secrets over the names the board shares. Default: none. */
  env?: NodeJS.ProcessEnv;
}

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar => ["string", "number", "boolean"].includes(typeof v);

const SECRET_KEY_RE = /(authorization|api[-_]?key|token|secret|password|credential|private[-_]?key)/i;
function deepRedact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : deepRedact(v, depth + 1);
    return out;
  }
  return value;
}

function buildUrl(
  base: string,
  op: OpenApiOperation,
  pathParams: Record<string, unknown>,
  query: Record<string, unknown>,
): { url: string } | { error: string } {
  const names = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  for (const n of names)
    if (!isScalar(pathParams[n])) return { error: `path parameter ${n} is required and must be a scalar` };
  for (const n of Object.keys(pathParams))
    if (!names.includes(n)) return { error: `unknown path parameter ${n}` };
  let resolved = op.path;
  for (const n of names) resolved = resolved.split(`{${n}}`).join(encodeURIComponent(String(pathParams[n])));
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (!isScalar(v)) return { error: `query parameter ${k} must be a scalar` };
    search.append(k, String(v));
  }
  const qs = search.toString();
  return { url: `${trimTrailingSlashes(base)}${resolved}${qs ? `?${qs}` : ""}` };
}

/**
 * A health check: one GET on the base URL with the credential. Any answer that
 * is not a server error and not a refusal of the credential means the service
 * is there (operations have their own paths; the base may well be a 404).
 */
export async function probeOpenApi(
  target: OpenApiTarget,
  manifest: OpenApiManifest,
  deps: OpenApiDeps,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const env = deps.env ?? {};
  const secret = target.authEnvName ? env[target.authEnvName]?.trim() || null : null;
  if (target.authEnvName && !secret)
    return { ok: false, status: null, error: notSetForCompany(target.authEnvName) };
  const headers: Record<string, string> = { accept: "application/json" };
  if (secret) {
    const header = (manifest.authHeader ?? "authorization").toLowerCase();
    headers[header] = (manifest.authScheme ?? "bearer") === "bearer" ? `Bearer ${secret}` : secret;
  }
  // A redirect is an answer like any other here: the service is there. Nothing follows it.
  const doFetch = egressFetch(deps.egress ?? defaultEgress(), {
    redirect: "manual",
    timeoutMs: manifest.timeoutMs,
    maxBytes: PROBE_MAX_BYTES,
  });
  try {
    const response = await doFetch(target.url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(manifest.timeoutMs),
    });
    // The status says it all; the body is never read.
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403)
      return {
        ok: false,
        status: response.status,
        error: `the service answered HTTP ${response.status}: the credential is refused`,
      };
    if (response.status >= 500)
      return { ok: false, status: response.status, error: `the service answered HTTP ${response.status}` };
    return { ok: true, status: response.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: `could not reach the service: ${scrubText((err as Error).message, [secret]).slice(0, 200)}`,
    };
  }
}

/**
 * Call one manifest operation. `args` is `{ pathParams, query, body }`; for a
 * write, `body` is the request body. Anything not in the manifest does not
 * exist. Returns the same shape as an MCP call so the broker treats both alike.
 */
export async function callOpenApiOperation(
  target: OpenApiTarget,
  manifest: OpenApiManifest,
  deps: OpenApiDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallOutcome> {
  const op = manifest.operations.find((o) => o.name === name);
  if (!op) return { ok: false, error: `${name} is not an operation on this connection` };
  const env = deps.env ?? {};
  const secret = target.authEnvName ? env[target.authEnvName]?.trim() || null : null;
  if (target.authEnvName && !secret)
    return { ok: false, error: `${notSetForCompany(target.authEnvName)}; nothing was called` };
  const pathParams = (
    args.pathParams && typeof args.pathParams === "object" ? args.pathParams : {}
  ) as Record<string, unknown>;
  const query = (args.query && typeof args.query === "object" ? args.query : {}) as Record<string, unknown>;
  const built = buildUrl(target.url, op, pathParams, query);
  if ("error" in built) return { ok: false, error: `${built.error}; nothing was called` };
  const headers: Record<string, string> = { accept: "application/json" };
  let payload: string | undefined;
  if (!READ_METHODS.has(op.method) && args.body !== undefined) {
    payload = JSON.stringify(args.body);
    if (Buffer.byteLength(payload, "utf8") > manifest.maxRequestBytes)
      return {
        ok: false,
        error: `the request body is over ${manifest.maxRequestBytes} bytes; nothing was called`,
      };
    headers["content-type"] = "application/json";
  }
  if (secret) {
    const header = (manifest.authHeader ?? "authorization").toLowerCase();
    headers[header] = (manifest.authScheme ?? "bearer") === "bearer" ? `Bearer ${secret}` : secret;
  }
  // A redirect is refused: an operation, a write above all, goes to the URL the manifest names or nowhere.
  const doFetch = egressFetch(deps.egress ?? defaultEgress(), {
    redirect: "error",
    timeoutMs: manifest.timeoutMs,
    maxBytes: manifest.maxResponseBytes + 1,
  });
  let response: Response;
  try {
    response = await doFetch(built.url, {
      method: op.method.toUpperCase(),
      headers,
      body: payload,
      signal: AbortSignal.timeout(manifest.timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      error: `${name} could not reach the service: ${scrubText((err as Error).message, [secret]).slice(0, 200)}`,
    };
  }
  if (!response.ok) {
    // Error bodies never travel, nor the server's reason phrase, which may echo the credential: the status only.
    await response.body?.cancel().catch(() => {});
    return { ok: false, error: `${name} answered HTTP ${response.status}` };
  }
  // Read up to the cap and no further, decoded: what a server compresses never grows past it in memory.
  let read: Awaited<ReturnType<typeof readCapped>>;
  try {
    read = await readCapped(response, manifest.maxResponseBytes);
  } catch (err) {
    return {
      ok: false,
      error: `${name} could not be read: ${scrubText((err as Error).message, [secret]).slice(0, 200)}`,
    };
  }
  const truncated = read.cut;
  // A byte order mark is no part of the answer, and JSON.parse refuses one.
  const raw = Buffer.from(read.bytes)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const clean = scrubber([secret]);
  return { ok: true, result: truncated ? { truncated: true, text: clean.cut(raw) } : readAnswer(raw, clean) };
}

/** A parsed value with secret-looking keys redacted and the credential out of every string. */
function cleaned(read: { value: unknown; numbers: number[] }, clean: Scrubber): unknown {
  return clean.value(deepRedact(read.value), read.numbers);
}

/**
 * A whole answer as the teammate reads it, read as JSON so a number in it is looked at as a number
 * (`Scrubber.json`): JSON cleaned; newline-delimited JSON (a log, an export) cleaned line by line and written
 * back as lines; anything else the scrubbed text.
 */
function readAnswer(raw: string, clean: Scrubber): unknown {
  const whole = clean.json(raw);
  if (whole) return cleaned(whole, clean);
  const lines = raw.split("\n");
  if (lines.filter((l) => l.trim()).length >= 2) {
    const read = lines.map((l) => (l.trim() ? clean.json(l) : null));
    if (read.every((r) => r !== undefined))
      return read.map((r, i) => (r ? JSON.stringify(cleaned(r, clean)) : lines[i])).join("\n");
  }
  return clean.text(raw);
}
