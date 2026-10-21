// Board configuration from the environment. Values here are the platform's
// own infrastructure settings, injected by the cluster or docker compose.
// Nothing user-supplied ever lands here.

import {
  isPublicOidcIssuer,
  otlpHeaders,
  otlpTracesEndpoint,
  parseCompanyCreators,
  parseSharedEnvNames,
  parseStdioCommands,
  type CompanyCreators,
  type OtlpTarget,
  type StdioCommand,
} from "@rosterdock/shared";
import type { OidcConfig } from "./auth/oidc.js";
import type { S3Config } from "./storage/s3.js";

export interface BoardConfig {
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: string;
  devLogin: boolean;
  cookieSecure: boolean;
  corsOrigin: string | null;
  sessionTtlSeconds: number;
  /** Requests a minute one client address may make to each sign-in route (ROSTERDOCK_SIGNIN_RATE_LIMIT); 0: no limit. */
  signInRateLimit: number;
  /** Shared secret the worker fleet presents to claim runs. Null disables claiming. */
  workerToken: string | null;
  reaperIntervalMs: number;
  runStaleAfterMs: number;
  /**
   * A task blocked on a teammate for longer than this is chased (by Peter's loop), once; this long after the
   * chase, or past it when nobody can be chased, the wait goes to a person.
   */
  chaseBlockedForMs: number;
  /** Connections per replica: the board's pool and the queue's pool each get this many. */
  dbPoolMax: number;
  /** Token the board opens pull requests with (ROSTERDOCK_GITHUB_TOKEN, a name in the cluster secret). Null: none opened. */
  githubToken: string | null;
  githubApiBase: string;
  /** Token the board opens merge requests with (ROSTERDOCK_GITLAB_TOKEN, by name). Null: GitLab repositories propose nothing. */
  gitlabToken: string | null;
  /** The GitLab API root (ROSTERDOCK_GITLAB_API); its host is the one repository URLs must carry. Default gitlab.com. */
  gitlabApiBase: string;
  /** Key Peter plans with (ANTHROPIC_API_KEY on the board, a name in the cluster secret). Null: heuristic plans. */
  anthropicApiKey: string | null;
  anthropicApiBase: string | null;
  /** The Claude Code CLI a company may plan with (ROSTERDOCK_PETER_CLAUDE_BIN, default claude), on its own sign-in. Null: not offered. */
  peterClaudeBin: string | null;
  /** The Codex CLI a company may plan with (ROSTERDOCK_PETER_CODEX_BIN, default codex). Null: not offered. */
  peterCodexBin: string | null;
  /** How often Peter's loop runs a pass over every company, besides on events. 0 disables the timer. */
  peterIntervalMs: number;
  /** Where needs-you notifications go for every company (ROSTERDOCK_NOTIFY_WEBHOOK_URL; may carry a token, never logged). Null: none, unless a company names its own. */
  notifyWebhookUrl: string | null;
  /** Email for every company (ROSTERDOCK_NOTIFY_SMTP_URL, an smtp:// or smtps:// URL with the credentials inside, never logged; ROSTERDOCK_NOTIFY_EMAIL_TO, comma-separated; ROSTERDOCK_NOTIFY_EMAIL_FROM). Null: none, unless a company names its own. */
  notifyEmail: { smtpUrl: string; to: string[]; from: string } | null;
  /** The URL people reach the board at (ROSTERDOCK_PUBLIC_URL), for OIDC redirects. Null: taken from the request. */
  publicUrl: string | null;
  /** Single sign-on through one OpenID Connect provider (ROSTERDOCK_OIDC_ISSUER and ROSTERDOCK_OIDC_CLIENT_ID). Null: none. */
  oidc: OidcConfig | null;
  /** Where a run's trace goes (OTEL_EXPORTER_OTLP_ENDPOINT or _TRACES_ENDPOINT, _HEADERS, OTEL_SERVICE_NAME). Null: no traces. */
  otlp: OtlpTarget | null;
  /** A bearer token scrapers must present on /metrics (ROSTERDOCK_METRICS_TOKEN, a name in the cluster secret). Null: /metrics is open on the board's port. */
  metricsToken: string | null;
  /** Fetch the sources a research document cites when its review opens (public http(s) only). */
  fetchSources: boolean;
  /** Object storage for artifacts over the inline limit (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY by name). Null: larger artifacts are refused. */
  storage: S3Config | null;
  /** A secret store the board may write to (ROSTERDOCK_SECRET_STORE: `kubernetes`, the pod's namespace; `file:<dir>` for dev). Null: none, so no OAuth on connections. */
  secretStore: SecretStoreConfig | null;
  /** Env var names on the board every company may name besides its own secrets (ROSTERDOCK_SHARED_ENV_NAMES). Empty: none. */
  sharedEnvNames: string[];
  /** The command lines a stdio connection may run inside the board (ROSTERDOCK_STDIO_COMMANDS). Empty: no stdio connection runs. */
  stdioCommands: StdioCommand[];
  /** Who may create a company (ROSTERDOCK_COMPANY_CREATORS). Null: the first company on an empty board, or anyone with the dev login on. */
  companyCreators: CompanyCreators | null;
}

export type SecretStoreConfig = { kind: "kubernetes" } | { kind: "file"; dir: string };

function secretStoreFrom(env: NodeJS.ProcessEnv): SecretStoreConfig | null {
  const raw = env.ROSTERDOCK_SECRET_STORE?.trim();
  if (!raw) return null;
  if (raw === "kubernetes") return { kind: "kubernetes" };
  if (raw.startsWith("file:") && raw.length > 5) return { kind: "file", dir: raw.slice(5) };
  throw new Error("ROSTERDOCK_SECRET_STORE must be kubernetes or file:<directory>");
}

function storageFrom(env: NodeJS.ProcessEnv): S3Config | null {
  const endpoint = env.S3_ENDPOINT?.trim();
  const bucket = env.S3_BUCKET?.trim();
  const accessKey = env.S3_ACCESS_KEY?.trim();
  const secretKey = env.S3_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    region: env.S3_REGION?.trim() || "us-east-1",
    accessKey,
    secretKey,
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "0" && env.S3_FORCE_PATH_STYLE !== "false",
  };
}

function otlpFrom(env: NodeJS.ProcessEnv): OtlpTarget | null {
  const endpoint = otlpTracesEndpoint(env);
  if (!endpoint) return null;
  return {
    endpoint,
    headers: otlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "rosterdock-board",
  };
}

function oidcFrom(env: NodeJS.ProcessEnv): OidcConfig | null {
  const issuer = env.ROSTERDOCK_OIDC_ISSUER?.trim();
  const clientId = env.ROSTERDOCK_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  const allowedDomains = (env.ROSTERDOCK_OIDC_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  // Anyone can hold an account at a public provider: without a domain list, anyone signs in. The operator
  // says so with `*`; an empty list there is the chart's default, not a choice, so the board will not start.
  if (!allowedDomains.length && isPublicOidcIssuer(issuer))
    throw new Error(
      `ROSTERDOCK_OIDC_ISSUER is ${issuer}, where anyone can hold an account, and ROSTERDOCK_OIDC_ALLOWED_DOMAINS is empty: list the email domains that may sign in (chart: board.oidc.allowedDomains), or * to let every account at the provider in`,
    );
  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret: env.ROSTERDOCK_OIDC_CLIENT_SECRET?.trim() || null,
    tokenAuth: env.ROSTERDOCK_OIDC_TOKEN_AUTH === "post" ? "post" : "basic",
    scopes: env.ROSTERDOCK_OIDC_SCOPES?.trim() || "openid email profile",
    displayName: env.ROSTERDOCK_OIDC_NAME?.trim() || "Single sign-on",
    allowedDomains,
  };
}

function notifyEmailFrom(env: NodeJS.ProcessEnv): BoardConfig["notifyEmail"] {
  const smtpUrl = env.ROSTERDOCK_NOTIFY_SMTP_URL?.trim();
  const to = (env.ROSTERDOCK_NOTIFY_EMAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!smtpUrl || !to.length) return null;
  return { smtpUrl, to, from: env.ROSTERDOCK_NOTIFY_EMAIL_FROM?.trim() || `rosterdock@${hostOf(smtpUrl)}` };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "rosterdock.local";
  } catch {
    return "rosterdock.local";
  }
}

function signInRateLimitFrom(raw: string | undefined): number {
  const n = Number(raw?.trim() || 60);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(
      `ROSTERDOCK_SIGNIN_RATE_LIMIT is requests a minute, a whole number (0 for no limit), not "${raw}"`,
    );
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BoardConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl,
    host: env.HOST ?? "127.0.0.1",
    // BOARD_PORT wins so a dev-server wrapper that injects PORT for the web app does not capture the board.
    port: Number(env.BOARD_PORT ?? env.PORT ?? 3000),
    logLevel: env.LOG_LEVEL ?? "info",
    devLogin: env.ROSTERDOCK_DEV_LOGIN === "1" || env.ROSTERDOCK_DEV_LOGIN === "true",
    cookieSecure: env.ROSTERDOCK_COOKIE_SECURE !== "0" && env.ROSTERDOCK_COOKIE_SECURE !== "false",
    corsOrigin: env.CORS_ORIGIN ?? null,
    sessionTtlSeconds: Number(env.ROSTERDOCK_SESSION_TTL_SECONDS ?? 30 * 24 * 3600),
    signInRateLimit: signInRateLimitFrom(env.ROSTERDOCK_SIGNIN_RATE_LIMIT),
    workerToken: env.ROSTERDOCK_WORKER_TOKEN?.trim() || null,
    reaperIntervalMs: Number(env.ROSTERDOCK_REAPER_INTERVAL_MS ?? 15_000),
    runStaleAfterMs: Number(env.ROSTERDOCK_RUN_STALE_AFTER_MS ?? 60_000),
    chaseBlockedForMs: Number(env.ROSTERDOCK_CHASE_BLOCKED_FOR_MS ?? 10 * 60_000),
    dbPoolMax: Number(env.ROSTERDOCK_DB_POOL_MAX ?? 10),
    githubToken: env.ROSTERDOCK_GITHUB_TOKEN?.trim() || null,
    githubApiBase: (env.ROSTERDOCK_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, ""),
    gitlabToken: env.ROSTERDOCK_GITLAB_TOKEN?.trim() || null,
    gitlabApiBase: (env.ROSTERDOCK_GITLAB_API ?? "https://gitlab.com/api/v4").replace(/\/+$/, ""),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    anthropicApiBase: env.ANTHROPIC_BASE_URL?.trim() || null,
    // The board looks for both CLIs unless ROSTERDOCK_PETER_CLIS=0; a name set here is looked for either way.
    peterClaudeBin:
      env.ROSTERDOCK_PETER_CLAUDE_BIN?.trim() || (env.ROSTERDOCK_PETER_CLIS === "0" ? null : "claude"),
    peterCodexBin:
      env.ROSTERDOCK_PETER_CODEX_BIN?.trim() || (env.ROSTERDOCK_PETER_CLIS === "0" ? null : "codex"),
    peterIntervalMs: Number(env.ROSTERDOCK_PETER_INTERVAL_MS ?? 30_000),
    notifyWebhookUrl: env.ROSTERDOCK_NOTIFY_WEBHOOK_URL?.trim() || null,
    notifyEmail: notifyEmailFrom(env),
    publicUrl: env.ROSTERDOCK_PUBLIC_URL?.trim().replace(/\/+$/, "") || null,
    oidc: oidcFrom(env),
    otlp: otlpFrom(env),
    storage: storageFrom(env),
    metricsToken: env.ROSTERDOCK_METRICS_TOKEN?.trim() || null,
    fetchSources: env.ROSTERDOCK_FETCH_SOURCES !== "0" && env.ROSTERDOCK_FETCH_SOURCES !== "false",
    secretStore: secretStoreFrom(env),
    sharedEnvNames: parseSharedEnvNames(env.ROSTERDOCK_SHARED_ENV_NAMES),
    stdioCommands: parseStdioCommands(env.ROSTERDOCK_STDIO_COMMANDS),
    companyCreators: parseCompanyCreators(env.ROSTERDOCK_COMPANY_CREATORS),
  };
}
