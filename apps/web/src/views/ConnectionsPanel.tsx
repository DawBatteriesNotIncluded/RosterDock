// Connections: the external systems this company can reach, on the Settings
// page. Add one from the catalog, by URL or command, or from an OpenAPI spec
// with an allowlist; discover its tools; flip a tool between read and write;
// confirm a tool only the server calls read-only; switch it off; remove it.
// Credentials are env var NAMES, never values; a connection may instead
// authorise by OAuth, when the board has a secret store, and its tokens live
// there. The web connection is the board's own fetch: added here once, with
// the company's list of web domains on its card.
import { Activity, KeyRound, Plug, Power, PowerOff, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { CreateConnectionInput, CreateOpenApiConnectionInput } from "@rosterdock/shared";
import type {
  CatalogEntry,
  CompanySecret,
  Connection,
  ConnectionTool,
  Features,
  OpenApiScan,
} from "../api/types.ts";
import { Button, Field, Pill, Tip } from "../components/ui.tsx";
import { relativeTime } from "../lib/format.ts";
import { DomainsField, domainsPhrase, parseDomains, webDomainsOf } from "./WebDomains.tsx";

export interface ConnectionsPanelProps {
  connections: Connection[];
  canEdit: boolean;
  loadCatalog(): Promise<CatalogEntry[]>;
  createConnection(input: CreateConnectionInput): Promise<Connection>;
  previewOpenApi(spec: string): Promise<OpenApiScan>;
  createOpenApiConnection(input: CreateOpenApiConnectionInput): Promise<Connection>;
  updateConnection(
    id: string,
    input: {
      enabled?: boolean;
      tools?: { name: string; write?: boolean; off?: boolean }[];
      /** The web connection's list of web domains; empty for any public site. */
      domains?: string[] | null;
    },
  ): Promise<Connection>;
  discoverConnection(id: string): Promise<Connection>;
  checkConnection(id: string): Promise<Connection>;
  deleteConnection(id: string): Promise<void>;
  /** Where to send the browser to authorise; the panel goes there. */
  startOAuth(id: string): Promise<{ url: string }>;
  /** What the board offers; without a secret store there is no OAuth and no secrets set from here. */
  features?: Features;
  /** Company secrets: names only. Setting one sends the value write-only to the board's secret store. */
  loadSecrets?(): Promise<CompanySecret[]>;
  setSecret?(name: string, value: string): Promise<CompanySecret>;
  deleteSecret?(name: string): Promise<void>;
  /** For headless rendering. */
  initialCatalog?: CatalogEntry[];
}

/** How a connection authenticates, in one phrase. */
export function credentialLine(c: Connection): string {
  if (c.oauth) {
    const secret = c.oauth.clientSecretEnvName ? ` · secret by name: ${c.oauth.clientSecretEnvName}` : "";
    return c.oauth.authorizedAt
      ? `OAuth · authorised ${relativeTime(c.oauth.authorizedAt)}${secret}`
      : `OAuth · not authorised yet${secret}`;
  }
  return c.authEnvName ? `by name: ${c.authEnvName}` : "no credential";
}

/** The last health check as one line, or null before the first. */
export function checkLine(c: Connection): string | null {
  const k = c.lastCheck;
  if (!k) return null;
  const when = relativeTime(k.at);
  if (!k.ok) return `Check failed ${when}: ${k.error ?? "no answer"}`;
  // Nothing is asked of the web connection: the board reads the web itself, or its operator keeps it off.
  if (c.kind === "web") return `Checked ${when} · the board reads the web`;
  const parts = [`Checked ${when} · answered in ${k.latencyMs} ms`];
  if (c.kind === "mcp") {
    parts.push(`${k.tools.seen} tool${k.tools.seen === 1 ? "" : "s"} listed`);
    if (k.tools.extra.length) parts.push(`${k.tools.extra.length} new: ${k.tools.extra.join(", ")}`);
    if (k.tools.missing.length) parts.push(`${k.tools.missing.length} gone: ${k.tools.missing.join(", ")}`);
  }
  return parts.join(" · ");
}

/**
 * The tools only the server calls read-only: neither their names nor the catalog say they read, so they are
 * writes, and each call waits for approval, until a person confirms them. A tool switched off waits for nothing.
 */
export function heldReads(c: Connection): ConnectionTool[] {
  return c.tools.filter((t) => t.source === "unconfirmed" && t.write && !t.off);
}

/** Confirming tools as reads: a person's classification of each, which discovery keeps. */
export function confirmAsRead(names: string[]): { tools: { name: string; write: boolean }[] } {
  return { tools: names.map((name) => ({ name, write: false })) };
}

/** What classified a tool, for its tooltip. */
function sourceNote(t: ConnectionTool): string {
  if (t.source === "person") return "set by a person";
  if (t.source === "unconfirmed")
    return "only the server calls it read-only; a write until a person confirms it";
  return t.source;
}

export function connectionSummary(c: Connection): string {
  if (c.kind === "web")
    return `Web · the board's own fetch · reads ${domainsPhrase(webDomainsOf(c))}${c.tools.some((t) => t.off) ? " · fetch switched off" : ""}`;
  const reads = c.tools.filter((t) => !t.write && !t.off).length;
  const writes = c.tools.filter((t) => t.write && !t.off).length;
  const off = c.tools.filter((t) => t.off).length;
  const where = c.kind === "openapi" ? c.url : c.transport === "stdio" ? c.command : c.url;
  return `${c.kind === "openapi" ? "OpenAPI" : c.transport === "stdio" ? "MCP · stdio" : "MCP · http"} · ${where ?? "?"} · ${reads} ${reads === 1 ? "read" : "reads"}, ${writes} ${writes === 1 ? "write" : "writes"}${off ? `, ${off} off` : ""}${c.discoveredAt ? ` · discovered ${relativeTime(c.discoveredAt)}` : c.kind === "mcp" ? " · not discovered yet" : ""}`;
}

function SecretValueField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange(v: string): void;
}) {
  return (
    <Field
      label={`Value for ${name}`}
      hint="Optional. Goes into this company's secrets under that name and is never shown again; leave empty for a name the board shares, or set it later under Secrets"
    >
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="paste the token"
        className="mono"
        style={{ width: 220 }}
      />
    </Field>
  );
}

/** Whether the board runs this typed command line: the same as a line it lists, or that line's start before a final `*`. */
export function stdioListed(lines: readonly string[], typed: string): boolean {
  const given = typed.trim().split(/\s+/).filter(Boolean);
  return lines.some((line) => {
    const listed = line.trim().split(/\s+/);
    const more = listed.at(-1) === "*";
    const fixed = more ? listed.slice(0, -1) : listed;
    return (
      (more ? given.length >= fixed.length : given.length === fixed.length) &&
      fixed.every((token, i) => given[i] === token)
    );
  });
}

/** An IPv4 address as a number, or null. */
function v4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** Whether an IPv4 address is in a range written as `a.b.c.d/n` (or is the address itself). */
function inV4Range(address: number, range: string): boolean {
  const [base, bitsText] = range.split("/");
  const start = v4(base ?? "");
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (start === null || !(bits >= 0 && bits <= 32)) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(start / size);
}

const PRIVATE_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
];
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".svc", ".cluster.local"];

/**
 * Whether a URL's host looks private and the operator's list does not name it: an address in a private,
 * loopback or link-local range, localhost, a name of one label or under a local suffix. The board decides by
 * what a name resolves to; this only says so before its check does.
 */
export function privateUnlisted(url: string, listed: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
  } catch {
    return false;
  }
  if (!host) return false;
  const entries = listed.map((e) => e.toLowerCase().replace(/^\[|\](?=\/|$)/g, ""));
  const address = v4(host);
  if (address !== null)
    return PRIVATE_V4.some((r) => inV4Range(address, r)) && !entries.some((e) => inV4Range(address, e));
  if (host.includes(":")) {
    const looks = host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
    return looks && !entries.includes(host);
  }
  const looks = host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s));
  return (
    looks &&
    !entries.some((e) =>
      e.startsWith("*.") ? host.endsWith(e.slice(1)) && host.length > e.length - 1 : e === host,
    )
  );
}

/** Under a URL the board would refuse: what this board reaches, and who changes it. */
function PrivateHint({ listed }: { listed: readonly string[] }) {
  return (
    <span className="hint" style={{ color: "var(--warn-ink)" }}>
      This board reaches public addresses, and private ones only where its operator lists them
      {listed.length ? `: ${listed.join(" · ")}` : ": none so far"}. A connection here is refused until the
      operator adds it (board.privateDestinations on the chart, or ROSTERDOCK_PRIVATE_DESTINATIONS).
    </span>
  );
}

function AddMcpForm({
  catalog,
  oauthOffered,
  stdioCommands,
  privateDestinations,
  onCreate,
  onSetSecret,
}: {
  catalog: CatalogEntry[];
  oauthOffered: boolean;
  /** The command lines the board runs for stdio connections; undefined until the board says. */
  stdioCommands?: string[];
  /** The private destinations the board reaches; undefined until the board says. */
  privateDestinations?: string[];
  /** Resolves true when the connection was made; the form then clears. */
  onCreate(input: CreateConnectionInput): Promise<boolean>;
  /** Set the credential's value under its name first, when one was typed; absent without a secret store. */
  onSetSecret?(name: string, value: string): Promise<boolean>;
}) {
  const [catalogId, setCatalogId] = useState("");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [authEnvName, setAuthEnvName] = useState("");
  const [auth, setAuth] = useState<"name" | "oauth">("name");
  const [clientId, setClientId] = useState("");
  const [clientSecretEnvName, setClientSecretEnvName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [busy, setBusy] = useState(false);
  const byOAuth = oauthOffered && transport === "http" && auth === "oauth";
  const picked = catalog.find((x) => x.id === catalogId);
  /** The connector authorises by OAuth only, and this board cannot: say so instead of asking for a token that does not exist. */
  const oauthOnlyUnavailable = picked?.auth === "oauth" && !oauthOffered;
  /** A stdio server runs inside the board, so only a command line the operator lists. */
  const stdioRefused =
    transport === "stdio" && stdioCommands !== undefined && !stdioListed(stdioCommands, command);
  /** The server looks private and the operator lists it nowhere: its check and calls will be refused. */
  const privateRefused =
    transport === "http" && privateDestinations !== undefined && privateUnlisted(url, privateDestinations);
  /** The name a typed value would be set under: the client secret's for OAuth, else the credential's. */
  const secretTarget = byOAuth
    ? clientId.trim()
      ? clientSecretEnvName.trim()
      : ""
    : oauthOnlyUnavailable
      ? ""
      : authEnvName.trim();
  const pick = (id: string) => {
    setCatalogId(id);
    const e = catalog.find((x) => x.id === id);
    if (!e) return;
    setName(e.id);
    setTransport(e.transport);
    setUrl(e.urlExample ?? "");
    setCommand(e.commandExample ?? "");
    setAuthEnvName(e.authEnvExample ?? "");
    setAuth(e.auth === "oauth" ? "oauth" : "name");
  };
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (
        onSetSecret &&
        secretTarget &&
        secretValue.trim() &&
        !(await onSetSecret(secretTarget, secretValue))
      )
        return;
      const [cmd, ...args] = command.trim().split(/\s+/).filter(Boolean);
      const made = await onCreate({
        name: name.trim(),
        catalogId: catalogId || undefined,
        transport,
        url: transport === "http" ? url.trim() || undefined : undefined,
        command: transport === "stdio" ? cmd : undefined,
        args: transport === "stdio" ? args : [],
        authEnvName: byOAuth ? undefined : authEnvName.trim() || undefined,
        oauth: byOAuth
          ? {
              clientId: clientId.trim() || undefined,
              clientSecretEnvName: clientId.trim() ? clientSecretEnvName.trim() || undefined : undefined,
            }
          : undefined,
      });
      if (!made) return;
      setCatalogId("");
      setName("");
      setUrl("");
      setCommand("");
      setAuthEnvName("");
      setClientId("");
      setClientSecretEnvName("");
      setSecretValue("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="fields" onSubmit={submit}>
      <Field label="From the catalog">
        <select value={catalogId} onChange={(e) => pick(e.target.value)}>
          <option value="">By URL or command…</option>
          {catalog.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} · {e.category}
              {e.transport === "stdio" && stdioCommands
                ? !stdioCommands.length
                  ? " · this board runs no commands"
                  : stdioListed(stdioCommands, e.commandExample ?? "")
                    ? " · runs on this board"
                    : " · its command must be one the operator allows"
                : e.transport === "http" &&
                    privateDestinations &&
                    privateUnlisted(e.urlExample ?? "", privateDestinations)
                  ? " · usually on a private address, which the operator must allow"
                  : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name" hint="Lowercase, no spaces; toolboxes use it: hubspot, slack">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="hubspot"
          style={{ width: 120 }}
        />
      </Field>
      <Field label="Transport">
        <select value={transport} onChange={(e) => setTransport(e.target.value as "http" | "stdio")}>
          <option value="http">MCP over HTTP</option>
          <option value="stdio">MCP over stdio</option>
        </select>
      </Field>
      {transport === "http" ? (
        <Field label="URL">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…/mcp"
            style={{ width: 240 }}
          />
        </Field>
      ) : (
        <Field label="Command" hint="Runs inside the board: one of the lines the operator allows">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx -y some-mcp-server"
            list="stdio-commands"
            style={{ width: 240 }}
          />
          <datalist id="stdio-commands">
            {(stdioCommands ?? []).map((line) => (
              <option key={line} value={line.replace(/\s\*$/, " ")} />
            ))}
          </datalist>
        </Field>
      )}
      {privateRefused ? <PrivateHint listed={privateDestinations ?? []} /> : null}
      {stdioRefused ? (
        <span className="hint" style={{ color: "var(--warn-ink)" }}>
          {stdioCommands?.length
            ? `This board runs only these commands for connections: ${stdioCommands.join(" · ")} (a final * takes any further arguments).`
            : "This board runs no commands for connections."}{" "}
          A stdio server runs inside the board, so the operator lists each command line it may run
          (board.stdioCommands on the chart, or ROSTERDOCK_STDIO_COMMANDS).
        </span>
      ) : null}
      {oauthOffered && transport === "http" ? (
        <Field label="Authentication">
          <select value={auth} onChange={(e) => setAuth(e.target.value as "name" | "oauth")}>
            <option value="name">Credential by name</option>
            <option value="oauth">Authorise by OAuth</option>
          </select>
        </Field>
      ) : null}
      {byOAuth ? (
        <>
          <Field label="Client id" hint="Empty: the board registers itself with the server">
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="optional"
              className="mono"
              style={{ width: 200 }}
            />
          </Field>
          {clientId.trim() ? (
            <Field
              label="Client secret env var NAME"
              hint="If the server issued one; a company secret, or a name the board shares"
            >
              <input
                value={clientSecretEnvName}
                onChange={(e) => setClientSecretEnvName(e.target.value)}
                placeholder="NOTION_OAUTH_CLIENT_SECRET"
                className="mono"
                style={{ width: 220 }}
              />
            </Field>
          ) : null}
        </>
      ) : oauthOnlyUnavailable ? (
        <span className="hint" style={{ color: "var(--warn-ink)" }}>
          {picked.name} authorises by OAuth only, and this board has no secret store to keep the tokens in.
          Turn one on (board.oauth.enabled on the chart, or ROSTERDOCK_SECRET_STORE) and add it again.
        </span>
      ) : (
        <Field label="Credential env var NAME" hint="A company secret, or a name the board shares">
          <input
            value={authEnvName}
            onChange={(e) => setAuthEnvName(e.target.value)}
            placeholder="HUBSPOT_MCP_TOKEN"
            className="mono"
            style={{ width: 200 }}
          />
        </Field>
      )}
      {onSetSecret && secretTarget ? (
        <SecretValueField name={secretTarget} value={secretValue} onChange={setSecretValue} />
      ) : null}
      <Button
        type="submit"
        variant="primary"
        disabled={busy || !name.trim() || oauthOnlyUnavailable || stdioRefused}
      >
        <Plug size={14} />
        <span>Add connection</span>
      </Button>
    </form>
  );
}

function AddOpenApiForm({
  privateDestinations,
  onPreview,
  onCreate,
  onSetSecret,
}: {
  /** The private destinations the board reaches; undefined until the board says. */
  privateDestinations?: string[];
  onPreview(spec: string): Promise<OpenApiScan>;
  /** Resolves true when the connection was made; the form then clears. */
  onCreate(input: CreateOpenApiConnectionInput): Promise<boolean>;
  onSetSecret?(name: string, value: string): Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authEnvName, setAuthEnvName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [specText, setSpecText] = useState("");
  const [scan, setScan] = useState<OpenApiScan | null>(null);
  const [allow, setAllow] = useState<Set<string>>(new Set());
  const [writes, setWrites] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The board reads JSON or YAML; the text goes as it is.
  const parse = (): string | null => specText.trim() || null;
  const preview = async () => {
    const spec = parse();
    if (!spec) {
      setError("Paste the spec first (JSON or YAML).");
      return;
    }
    setBusy(true);
    try {
      const s = await onPreview(spec);
      setScan(s);
      setAllow(new Set(s.operations.filter((o) => !o.write).map((o) => o.operationId)));
      setWrites(new Set());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const spec = parse();
    if (!spec || !name.trim() || !url.trim() || !allow.size) return;
    setBusy(true);
    try {
      if (
        onSetSecret &&
        authEnvName.trim() &&
        secretValue.trim() &&
        !(await onSetSecret(authEnvName.trim(), secretValue))
      )
        return;
      const made = await onCreate({
        name: name.trim(),
        url: url.trim(),
        authEnvName: authEnvName.trim() || undefined,
        spec,
        allow: [...allow],
        writes: [...writes],
      });
      if (!made) return;
      setName("");
      setUrl("");
      setAuthEnvName("");
      setSecretValue("");
      setSpecText("");
      setScan(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (set: Set<string>, id: string, on: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    on(next);
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <div className="fields">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="crm"
            style={{ width: 120 }}
          />
        </Field>
        <Field label="Base URL">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            style={{ width: 240 }}
          />
        </Field>
        {privateDestinations && privateUnlisted(url, privateDestinations) ? (
          <PrivateHint listed={privateDestinations} />
        ) : null}
        <Field label="Credential env var NAME">
          <input
            value={authEnvName}
            onChange={(e) => setAuthEnvName(e.target.value)}
            placeholder="CRM_API_TOKEN"
            className="mono"
            style={{ width: 200 }}
          />
        </Field>
        {onSetSecret && authEnvName.trim() ? (
          <SecretValueField name={authEnvName.trim()} value={secretValue} onChange={setSecretValue} />
        ) : null}
        <Button type="button" disabled={busy || !specText.trim()} onClick={() => void preview()}>
          Preview operations
        </Button>
      </div>
      <Field
        label="OpenAPI 3.x spec (JSON)"
        hint="Only the operations you tick exist on the connection. GET and HEAD read; everything else writes."
      >
        <textarea
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          className="mono"
          style={{ minHeight: 80 }}
          placeholder='{"openapi":"3.1.0", "paths": {...}}'
        />
      </Field>
      {error ? <Pill tone="bad">{error}</Pill> : null}
      {scan ? (
        <table className="costs">
          <thead>
            <tr>
              <th>Expose</th>
              <th>Operation</th>
              <th>Method and path</th>
              <th>Classification</th>
            </tr>
          </thead>
          <tbody>
            {scan.operations.map((o) => (
              <tr key={o.operationId}>
                <td>
                  <input
                    type="checkbox"
                    checked={allow.has(o.operationId)}
                    onChange={() => toggle(allow, o.operationId, setAllow)}
                    aria-label={`expose ${o.operationId}`}
                  />
                </td>
                <td className="mono">{o.name}</td>
                <td className="mono text-muted">
                  {o.method.toUpperCase()} {o.path}
                </td>
                <td>
                  {o.write ? (
                    <Pill tone="warn">write</Pill>
                  ) : (
                    <label className="flex items-center gap-1.5 text-[12px]">
                      <input
                        type="checkbox"
                        checked={writes.has(o.operationId)}
                        onChange={() => toggle(writes, o.operationId, setWrites)}
                      />
                      treat as a write
                    </label>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {scan ? (
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !name.trim() || !url.trim() || !allow.size}
          >
            Add OpenAPI connection
          </Button>
        </div>
      ) : null}
    </form>
  );
}

/** The web connection: the board's own fetch, one per company, with the company's list of web domains. */
export function AddWebForm({
  existing,
  offline,
  onCreate,
}: {
  existing: Connection | undefined;
  /** The operator keeps this board off the web. */
  offline: boolean;
  /** Resolves true when the connection was made; the form then clears. */
  onCreate(input: CreateConnectionInput): Promise<boolean>;
}) {
  const [name, setName] = useState("web");
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = parseDomains(domains);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!name.trim() || parsed.bad !== null) return;
    setBusy(true);
    try {
      if (await onCreate({ name: name.trim(), kind: "web", domains: parsed.domains })) setDomains("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="hint">
        The board reads public web pages for the teammates you grant it to: http and https only, every address
        checked, every page recorded in Activity (the address, the status, the size, never what it says).
        Teammates call it as a read; it never writes. A department and a client can narrow its sites, never
        widen them.
        {offline ? " This board's operator keeps it off the web, so for now it reads no page." : ""}
      </span>
      {existing ? (
        <span className="hint">
          This company has its web connection: {existing.name}. Its sites are on its card above.
        </span>
      ) : (
        <form className="fields" onSubmit={submit}>
          <Field label="Name" hint="Toolboxes use it">
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 120 }} />
          </Field>
          <Field label="Sites" hint="Domains, each with the sites under it; empty for any public site">
            <input
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="gong.io, developers.hubspot.com"
              className="mono"
              style={{ width: 280 }}
            />
          </Field>
          {parsed.bad !== null ? <Pill tone="bad">{`${parsed.bad} is not a domain`}</Pill> : null}
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || parsed.bad !== null}>
            <Plug size={14} />
            <span>Add the web connection</span>
          </Button>
        </form>
      )}
    </div>
  );
}

/** Company secrets: the names a value was set for, and a form to set or replace one. Never a value. */
function SecretsSection({
  canEdit,
  load,
  set,
  remove,
}: {
  canEdit: boolean;
  load(): Promise<CompanySecret[]>;
  set(name: string, value: string): Promise<unknown>;
  remove(name: string): Promise<unknown>;
}) {
  const [secrets, setSecrets] = useState<CompanySecret[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => load().then(setSecrets, (err: Error) => setError(err.message));
  useEffect(() => {
    void load().then(setSecrets, (err: Error) => setError(err.message));
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
      await refresh();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!name.trim() || !value.trim()) return;
    if (await act(() => set(name.trim(), value))) {
      setName("");
      setValue("");
    }
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">Secrets</span>
        <span className="hint">
          Values for the names connections use, kept in the board&apos;s secret store for this company alone.
          A value set here is used before a name the board shares, and is never shown again; set it again to
          replace it.
        </span>
      </div>
      {error ? <Pill tone="bad">{error}</Pill> : null}
      {secrets.length ? (
        <div className="flex flex-wrap gap-2">
          {secrets.map((s) => (
            <span
              key={s.name}
              className="flex items-center gap-1.5 rounded-[6px] border border-border px-2 py-1 text-[12px]"
            >
              <KeyRound size={12} />
              <span className="mono">{s.name}</span>
              <span className="text-muted">set {relativeTime(s.updatedAt)}</span>
              {canEdit ? (
                <>
                  <button className="link" onClick={() => setName(s.name)} disabled={busy}>
                    replace
                  </button>
                  <button className="link" onClick={() => void act(() => remove(s.name))} disabled={busy}>
                    remove
                  </button>
                </>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <span className="hint">No values set here yet.</span>
      )}
      {canEdit ? (
        <form className="fields" onSubmit={submit}>
          <Field label="Name" hint="The env var NAME a connection uses">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="HUBSPOT_MCP_TOKEN"
              className="mono"
              style={{ width: 220 }}
            />
          </Field>
          <Field label="Value">
            <input
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="paste the token"
              className="mono"
              style={{ width: 220 }}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || !value.trim()}>
            <KeyRound size={14} />
            <span>Set value</span>
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** A connection's tools only the server calls read-only, each with a person's confirmation to give. */
function HeldReads({
  connection,
  held,
  canEdit,
  onConfirm,
}: {
  connection: string;
  held: ConnectionTool[];
  canEdit: boolean;
  onConfirm(names: string[]): Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = async (names: string[]) => {
    setBusy(true);
    try {
      await onConfirm(names);
    } finally {
      setBusy(false);
    }
  };
  const one = held.length === 1;
  return (
    <div className="flex flex-col gap-1.5 rounded-[6px] border border-border px-2.5 py-2 text-[12px]">
      <span>
        <span className="font-semibold">
          {connection} says {one ? "this tool only reads" : `these ${held.length} tools only read`}.
        </span>{" "}
        <span className="text-muted">
          Neither {one ? "its name" : "their names"} nor the catalog says so, so a call to{" "}
          {one ? "it" : "one"} waits for approval as a write until{" "}
          {canEdit ? "you confirm" : "an owner or admin confirms"} it reads.
          {canEdit ? " Confirm a tool once you are sure it changes nothing." : ""}
        </span>
      </span>
      <div className="chips">
        {held.map((t) => (
          <span
            key={t.name}
            className="flex items-center gap-1.5 rounded-[6px] border border-border px-2 py-1"
            title={t.description || undefined}
          >
            <span className="mono">{t.name}</span>
            {canEdit ? (
              <button
                className="link"
                aria-label={`Confirm ${t.name} as read`}
                disabled={busy}
                onClick={() => void confirm([t.name])}
              >
                Confirm as read
              </button>
            ) : null}
          </span>
        ))}
        {canEdit && !one ? (
          <Button size="sm" disabled={busy} onClick={() => void confirm(held.map((t) => t.name))}>
            Confirm all {held.length} as reads
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ConnectionsPanel(p: ConnectionsPanelProps) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>(p.initialCatalog ?? []);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<"mcp" | "openapi" | "web">("mcp");
  const web = p.connections.find((c) => c.kind === "web");
  useEffect(() => {
    if (p.initialCatalog) return;
    void p.loadCatalog().then(setCatalog, (err: Error) => setError(err.message));
  }, [p.loadCatalog, p.initialCatalog]);
  /** Run a write; true when it went through, the card's error line otherwise. */
  const wrap = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      setError(null);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  // The add forms set a typed value under its name before creating the connection; only with a store.
  const setSecretFirst = p.setSecret;
  const setSecret =
    p.features?.oauth && setSecretFirst
      ? (name: string, value: string) => wrap(() => setSecretFirst(name, value))()
      : undefined;
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">Connections</span>
        <span className="hint">
          The live systems teammates can reach, always through the board. Reads run; writes wait for you in
          Approvals. Credentials are env var names: this company&apos;s secrets, or names the board shares
          {p.features?.sharedEnvNames ? ` (${p.features.sharedEnvNames.join(", ") || "none"})` : ""}; the rest
          of the board&apos;s environment never reaches a company, and no value is stored here.
          {p.features?.oauth
            ? " A value can be set under its name below; it goes into the board's secret store and is never shown again. A connection may authorise by OAuth instead; its tokens live in the same store."
            : ""}
        </span>
      </div>
      {error ? <Pill tone="bad">{error}</Pill> : null}
      <div className="flex flex-col gap-2">
        {p.connections.map((c) => (
          <div key={c.id} className="flex flex-col gap-2 rounded-[8px] border border-border px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <button className="link" onClick={() => setOpen(open === c.id ? null : c.id)}>
                {c.name}
              </button>
              <Pill tone={c.enabled ? "ok" : "muted"}>{c.enabled ? "on" : "off"}</Pill>
              <span className="text-[12px] text-muted">{connectionSummary(c)}</span>
              {c.kind === "web" ? null : c.authEnvName ? (
                <Tip text="Credential by name">
                  <span className="tool">{c.authEnvName}</span>
                </Tip>
              ) : c.oauth ? (
                <Pill tone={c.oauth.authorizedAt ? "ok" : "warn"}>{credentialLine(c)}</Pill>
              ) : (
                <span className="text-[12px] text-muted">no credential</span>
              )}
              {p.canEdit ? (
                <span className="ml-auto flex gap-1.5">
                  {c.oauth ? (
                    <Tip text="Go to the server's consent page; the board keeps the tokens">
                      <Button
                        size="sm"
                        variant={c.oauth.authorizedAt ? "ghost" : "accent"}
                        onClick={wrap(async () => {
                          const { url } = await p.startOAuth(c.id);
                          window.location.assign(url);
                        })}
                      >
                        <KeyRound size={14} />
                        <span>{c.oauth.authorizedAt ? "Authorise again" : "Authorise"}</span>
                      </Button>
                    </Tip>
                  ) : null}
                  <Tip text="Does it answer with this credential, and still list what we know?">
                    <Button size="sm" onClick={wrap(() => p.checkConnection(c.id))}>
                      <Activity size={14} />
                      <span>Check</span>
                    </Button>
                  </Tip>
                  {c.kind === "mcp" ? (
                    <Tip text="Ask the server for its tools again">
                      <Button size="sm" onClick={wrap(() => p.discoverConnection(c.id))}>
                        <RefreshCw size={14} />
                        <span>Discover</span>
                      </Button>
                    </Tip>
                  ) : null}
                  <Button size="sm" onClick={wrap(() => p.updateConnection(c.id, { enabled: !c.enabled }))}>
                    {c.enabled ? "Switch off" : "Switch on"}
                  </Button>
                  <Tip text="Remove">
                    <Button size="sm" aria-label="Remove" onClick={wrap(() => p.deleteConnection(c.id))}>
                      <Trash2 size={14} />
                    </Button>
                  </Tip>
                </span>
              ) : null}
            </div>
            {checkLine(c) ? (
              <span
                className="text-[12px]"
                style={{ color: c.lastCheck?.ok ? "var(--muted)" : "var(--bad)" }}
              >
                {checkLine(c)}
              </span>
            ) : null}
            {heldReads(c).length ? (
              <HeldReads
                connection={c.name}
                held={heldReads(c)}
                canEdit={p.canEdit}
                onConfirm={(names) => wrap(() => p.updateConnection(c.id, confirmAsRead(names)))()}
              />
            ) : null}
            {c.kind === "web" ? (
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="text-muted">Sites</span>
                {p.canEdit ? (
                  <DomainsField
                    label={`${c.name} sites`}
                    value={webDomainsOf(c)}
                    placeholder="any public site"
                    onSave={(domains) => wrap(() => p.updateConnection(c.id, { domains }))()}
                  />
                ) : (
                  <span>{domainsPhrase(webDomainsOf(c))}</span>
                )}
                {p.features?.web === false ? (
                  <span style={{ color: "var(--warn-ink)" }}>
                    This board&apos;s operator keeps it off the web: it reads no page.
                  </span>
                ) : null}
              </div>
            ) : null}
            {open === c.id ? (
              <div className="chips">
                {c.tools.map((t) => (
                  <span key={t.name} className="chips" style={{ gap: 2 }}>
                    <button
                      className="tool"
                      title={`${t.description || t.name} · ${sourceNote(t)}${t.off ? " · switched off by a person; refused for every teammate" : p.canEdit ? ". Click to flip." : ""}`}
                      disabled={!p.canEdit || !!t.off}
                      onClick={wrap(() =>
                        p.updateConnection(c.id, { tools: [{ name: t.name, write: !t.write }] }),
                      )}
                      style={{
                        color: t.off ? "var(--muted)" : t.write ? "var(--warn-ink)" : undefined,
                        textDecoration: t.off ? "line-through" : undefined,
                      }}
                    >
                      {t.name} · {t.off ? "off" : t.write ? "write" : "read"}
                    </button>
                    {p.canEdit ? (
                      <button
                        className="tool"
                        aria-label={t.off ? `Switch ${t.name} on` : `Switch ${t.name} off`}
                        title={
                          t.off
                            ? "Switch this tool on again for every teammate"
                            : "Switch this tool off for every teammate; it is refused whatever a toolbox grants"
                        }
                        onClick={wrap(() =>
                          p.updateConnection(c.id, { tools: [{ name: t.name, off: !t.off }] }),
                        )}
                      >
                        {t.off ? <Power size={11} /> : <PowerOff size={11} />}
                      </button>
                    ) : null}
                  </span>
                ))}
                {c.tools.length === 0 ? (
                  <span className="text-[12px] text-muted">No tools known yet. Discover them.</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {p.connections.length === 0 ? (
          <span className="hint">
            No connections yet. Add one below; then grant it to teammates in their toolbox.
          </span>
        ) : null}
      </div>
      {p.features?.oauth && p.loadSecrets && p.setSecret && p.deleteSecret ? (
        <SecretsSection canEdit={p.canEdit} load={p.loadSecrets} set={p.setSecret} remove={p.deleteSecret} />
      ) : null}
      {p.canEdit ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex gap-2">
            <Button size="sm" variant={kind === "mcp" ? "primary" : "ghost"} onClick={() => setKind("mcp")}>
              MCP server
            </Button>
            <Button
              size="sm"
              variant={kind === "openapi" ? "primary" : "ghost"}
              onClick={() => setKind("openapi")}
            >
              OpenAPI service
            </Button>
            <Button size="sm" variant={kind === "web" ? "primary" : "ghost"} onClick={() => setKind("web")}>
              Web, built in
            </Button>
          </div>
          {kind === "web" ? (
            <AddWebForm
              existing={web}
              offline={p.features?.web === false}
              onCreate={(i) => wrap(() => p.createConnection(i))()}
            />
          ) : kind === "mcp" ? (
            <AddMcpForm
              catalog={catalog}
              oauthOffered={!!p.features?.oauth}
              stdioCommands={p.features?.stdioCommands}
              privateDestinations={p.features?.privateDestinations}
              onCreate={(i) => wrap(() => p.createConnection(i))()}
              onSetSecret={setSecret}
            />
          ) : (
            <AddOpenApiForm
              privateDestinations={p.features?.privateDestinations}
              onPreview={p.previewOpenApi}
              onCreate={(i) => wrap(() => p.createOpenApiConnection(i))()}
              onSetSecret={setSecret}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
