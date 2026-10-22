import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { stdioCommandLine } from "@rosterdock/shared";
import Fastify, { type FastifyInstance } from "fastify";
import type { ApprovalExecutor } from "./approvals/service.js";
import { brokerExecutor } from "./broker/broker.js";
import { registerGuard } from "./auth/guard.js";
import { registerAuth } from "./auth/plugin.js";
import type { BoardConfig } from "./config.js";
import { createPool, type Db } from "./db/pool.js";
import { createEventBus, type EventBus } from "./events/bus.js";
import type { GitHubProvider } from "./git/github.js";
import type { GitHosts } from "./git/hosts.js";
import { HttpError } from "./http-error.js";
import { createRunQueue, type RunQueue } from "./queue.js";
import { mcpClientPool, type McpClientDeps } from "./mcp/client.js";
import { startNotifier, type NotifyDeps } from "./notify/notify.js";
import type { SmtpOptions } from "./notify/smtp.js";
import { registerNotifyRoutes } from "./routes/notify.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSecretRoutes } from "./routes/secrets.js";
import { registerBudgetRoutes } from "./routes/budgets.js";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerDepartmentRoutes } from "./routes/departments.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerPeterRoutes } from "./routes/peter.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTeammateRoutes } from "./routes/teammates.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerDriftRoutes } from "./routes/drift.js";
import { registerOfficeRoutes } from "./routes/office.js";
import { sharedEnv } from "./secrets/company.js";
import { fileSecretStore } from "./secrets/file.js";
import type { OperatorPolicy } from "./operator.js";
import { inClusterSecretsConfig, kubernetesSecretStore } from "./secrets/kubernetes.js";
import type { SecretStore } from "./secrets/store.js";
import { startDriftWatch } from "./drift/drift.js";
import { registerMetrics } from "./observability/metrics.js";
import { otlpSink, type SpanSink } from "./observability/spans.js";
import { startRunTracer } from "./observability/tracing.js";
import { registerWorkerRoutes } from "./routes/worker.js";
import type { PeterDeps } from "./peter/goals.js";
import { startPeterLoop, type PeterLoop } from "./peter/loop.js";
import { claudeCliModel } from "./peter/claude-cli.js";
import { codexCliModel } from "./peter/codex-cli.js";
import { plannerRouter, probePlanners, type PlannerStatus } from "./peter/planners.js";
import { anthropicModel, tracedModel, type PeterModel } from "./peter/model.js";
import { startReaper } from "./runs/reaper.js";
import { sourceFetcher, type SourceFetcher } from "./reviews/sources.js";
import { isUuid } from "./validate.js";
import { boardEgress, type Egress } from "./web/egress.js";
import { boardWebReader, type Resolve, type WebReader } from "./web/transport.js";
import { s3Store, type ObjectStore } from "./storage/s3.js";
import { registerStyleRoutes } from "./routes/styles.js";
import { STYLE_PACKS, VENDOR_DIR, type StylePack } from "./styles/catalog.js";

export interface BoardApp {
  app: FastifyInstance;
  db: Db;
  bus: EventBus;
  queue: RunQueue;
  /** Peter's loop, when the config runs one (ROSTERDOCK_PETER_INTERVAL_MS > 0). */
  peter: PeterLoop | null;
  close(): Promise<void>;
}

export interface BuildOptions {
  logger?: boolean;
  /** Off in tests, where the reaper runs by hand. */
  reaper?: boolean;
  /** The fetch the GitHub provider uses; tests replay recorded responses. Default: global fetch. */
  githubFetch?: typeof fetch;
  /** The fetch the GitLab provider uses; tests replay recorded responses. Default: global fetch. */
  gitlabFetch?: typeof fetch;
  /** The fetch Peter's model client uses; tests replay recorded responses and set a key. Default: global fetch. */
  modelFetch?: typeof fetch;
  /** Put before the Claude CLI's arguments when Peter plans through it; tests run a recorded replayer with node. */
  peterCliPrefixArgs?: string[];
  /** The same for the Codex CLI. */
  peterCodexPrefixArgs?: string[];
  /** What a style pack's file is downloaded with, under the egress check (egressResolve); tests use a fake. Default: the board's pinned transport. */
  stylesFetch?: typeof fetch;
  /** The style packs offered; tests pin their own stand-in files. Default: styles/catalog.ts. */
  styleCatalog?: readonly StylePack[];
  /** Where the build carries the packs' files; null for none. Default: apps/board/styles/vendor. */
  stylesVendorDir?: string | null;
  /** What the board is told about its planners instead of asking the CLIs; tests. */
  plannerStatuses?: () => Promise<PlannerStatus[]>;
  /** Sends an approved write to its live system. Tests inject one; the default sends nothing until a connection exists. */
  approvalExecutor?: ApprovalExecutor;
  /**
   * What HTTP connections (MCP and OpenAPI) and their OAuth are sent with, under the egress check
   * (egressResolve); tests replay recorded JSON-RPC. Default: the board's pinned transport.
   */
  mcpFetch?: typeof fetch;
  /**
   * What needs-you webhooks are posted with: the board's own as it is, a company's under the egress check;
   * tests record the posts. Default: global fetch for the board's own, the pinned transport for a company's.
   */
  notifyFetch?: typeof fetch;
  /** For the SMTP client behind email notifications: a private CA in tests. */
  smtp?: SmtpOptions;
  /** The board's environment, where the names the operator shares (ROSTERDOCK_SHARED_ENV_NAMES) resolve. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** The fetch the OIDC sign-in talks to the identity provider with; tests use a fake provider. Default: global fetch. */
  oidcFetch?: typeof fetch;
  /** The fetch run traces are posted to the OTLP collector with; tests record the posts. Default: global fetch. */
  otlpFetch?: typeof fetch;
  /** The fetch the object store is reached with; tests replay recorded MinIO responses. Default: global fetch. */
  storageFetch?: typeof fetch;
  /**
   * What the board reads the web with (research sources when a review opens, the web connection's pages):
   * a fetch that follows no redirect, and the resolver every hop's name is checked with. Tests inject both.
   * Default: node's HTTP client pinned to the addresses the system resolver gives, once each is public.
   */
  webFetch?: typeof fetch;
  webResolve?: Resolve;
  /**
   * What the names a company chose are checked with before anything is sent (a connection's server, its OAuth
   * endpoints, a company's webhook and SMTP server, a style pack's host): every address public, or private
   * where ROSTERDOCK_PRIVATE_DESTINATIONS allows it. Tests inject one. Default: the system resolver.
   */
  egressResolve?: Resolve;
  /** The fetch the Kubernetes secret store reaches the API server with; tests use a fake. Default: global fetch. */
  secretsFetch?: typeof fetch;
}

export async function buildApp(config: BoardConfig, opts: BuildOptions = {}): Promise<BoardApp> {
  const db = createPool(config.databaseUrl, config.dbPoolMax);
  const app = Fastify({
    // One JSON object per line (pino). Credentials never reach a log line: the headers that carry them
    // are redacted, and nothing else logs a value. A request id comes from the proxy or is minted.
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'req.headers["x-rosterdock-worker-token"]',
                "res.headers['set-cookie']",
              ],
              censor: "[redacted]",
            },
          },
    requestIdHeader: "x-request-id",
    trustProxy: true,
  });
  const warn = (m: string) => app.log.warn(m);
  const bus = createEventBus(db, config.databaseUrl, { warn });
  const queue = createRunQueue(config.databaseUrl, { warn }, { max: config.dbPoolMax });
  const github: GitHubProvider = {
    fetch: opts.githubFetch ?? ((input, init) => fetch(input, init)),
    token: config.githubToken,
    apiBase: config.githubApiBase,
  };
  const hosts: GitHosts = {
    github,
    gitlab: config.gitlabToken
      ? {
          fetch: opts.gitlabFetch ?? ((input, init) => fetch(input, init)),
          token: config.gitlabToken,
          apiBase: config.gitlabApiBase,
        }
      : null,
  };

  // The web, when the operator lets the board read it: research sources and the web connection share it.
  const board = boardWebReader(opts.webResolve);
  const web: WebReader | null = config.fetchSources
    ? { fetch: opts.webFetch ?? board.fetch, resolve: opts.webResolve ?? board.resolve }
    : null;
  const sources: SourceFetcher | null = web ? sourceFetcher(web) : null;
  // What a company chose the board should reach: public addresses, and the private ones the operator lists.
  // Each call site keeps its own transport in tests; the check above it is the same everywhere.
  const egress = boardEgress(config.privateDestinations, opts.egressResolve);
  // An injected transport stays itself for every company: only the list is narrowed (companyEgress).
  const reach = (transport: typeof fetch | undefined): Egress =>
    transport ? { fetch: transport, resolve: egress.resolve, allow: egress.allow } : egress;
  // Artifacts over the inline limit live here, when the config names a bucket.
  const store: ObjectStore | null = config.storage
    ? s3Store(config.storage, opts.storageFetch ? { fetch: opts.storageFetch } : {})
    : null;
  // A secret store the board may write to: the cluster's Secrets in a pod, files in dev. Without one, no OAuth.
  const secrets: SecretStore | null =
    config.secretStore?.kind === "kubernetes"
      ? kubernetesSecretStore(
          await inClusterSecretsConfig(),
          opts.secretsFetch ? { fetch: opts.secretsFetch } : {},
        )
      : config.secretStore?.kind === "file"
        ? fileSecretStore(config.secretStore.dir)
        : null;

  // A company's names resolve from its own secrets and from what the operator shares, never from the rest
  // of the board's environment; the routes that take a name refuse one that is the board's own.
  const boardEnv = opts.env ?? process.env;
  const shared = sharedEnv(boardEnv, config.sharedEnvNames);
  const operator: OperatorPolicy = {
    boardEnv,
    sharedEnvNames: config.sharedEnvNames,
    store: secrets,
    stdioCommands: config.stdioCommands,
    devLogin: config.devLogin,
    companyCreators: config.companyCreators,
  };

  // stdio children stay up between calls and go when idle; closed with the board.
  const mcpPool = mcpClientPool();
  const mcp: McpClientDeps = {
    egress: reach(opts.mcpFetch),
    env: shared,
    secrets,
    log: { warn: (msg) => app.log.warn(msg) },
    pool: mcpPool,
    stdioCommands: config.stdioCommands,
    web,
  };
  const notify: NotifyDeps = {
    db,
    ...(opts.notifyFetch ? { fetch: opts.notifyFetch } : {}),
    egress: reach(opts.notifyFetch),
    env: shared,
    secrets,
    defaultWebhookUrl: config.notifyWebhookUrl,
    defaultEmail: config.notifyEmail,
    ...(opts.smtp ? { smtp: opts.smtp } : {}),
    log: { warn },
  };

  // Spans that are not a run's (Peter's model calls, a manager's reads outside a run) go to the same collector.
  const spans: SpanSink | null = config.otlp
    ? otlpSink(config.otlp, opts.otlpFetch ?? ((input, init) => fetch(input, init)), { warn })
    : null;
  // Peter's brains: each company's choice in Settings, or the first that works here (planners.ts).
  const claudeTarget = config.peterClaudeBin
    ? {
        bin: config.peterClaudeBin,
        ...(opts.peterCliPrefixArgs ? { prefixArgs: opts.peterCliPrefixArgs } : {}),
      }
    : null;
  const codexTarget = config.peterCodexBin
    ? {
        bin: config.peterCodexBin,
        ...(opts.peterCodexPrefixArgs ? { prefixArgs: opts.peterCodexPrefixArgs } : {}),
      }
    : null;
  const planners = plannerRouter({
    db,
    models: {
      ...(claudeTarget ? { claude_cli: claudeCliModel(claudeTarget) } : {}),
      ...(codexTarget ? { codex_cli: codexCliModel(codexTarget) } : {}),
      ...(config.anthropicApiKey
        ? {
            api: anthropicModel({
              apiKey: config.anthropicApiKey,
              apiBase: config.anthropicApiBase,
              ...(opts.modelFetch ? { fetch: opts.modelFetch } : {}),
            }),
          }
        : {}),
    },
    probe:
      opts.plannerStatuses ??
      (() => probePlanners({ claude: claudeTarget, codex: codexTarget, apiKey: !!config.anthropicApiKey })),
  });
  const model: PeterModel = planners;
  const peter: PeterDeps = {
    db,
    queue,
    github,
    model: spans ? tracedModel(model, spans) : model,
    log: { warn },
    chase: { blockedForMs: config.chaseBlockedForMs },
    store,
  };

  await app.register(cookie);
  if (config.corsOrigin)
    await app.register(cors, { origin: config.corsOrigin.split(","), credentials: true });
  // Counts only on the routes that ask for it: the sign-in routes (auth/plugin.ts). Any wider limit is the
  // ingress's (docs/security.md).
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode);
      return { error: err.message, details: err.details ?? undefined };
    }
    const known = err as { statusCode?: number; message?: string };
    if (known.statusCode && known.statusCode >= 400 && known.statusCode < 500) {
      reply.code(known.statusCode);
      return { error: known.message ?? "request failed" };
    }
    app.log.error(err as Error);
    reply.code(500);
    return { error: "internal error" };
  });

  app.get("/api/health", { config: { public: true } }, async () => ({ ok: true }));
  app.get("/api/ready", { config: { public: true } }, async (_req, reply) => {
    try {
      await db.query("SELECT 1");
      return { ok: true };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });

  registerAuth(app, db, config, {
    fetch: opts.oidcFetch ?? ((input, init) => fetch(input, init)),
    log: { warn },
  });
  registerGuard(app, db);
  registerCompanyRoutes(app, db, operator);
  registerTeammateRoutes(app, db);
  registerDepartmentRoutes(app, db);
  registerProjectRoutes(app, db);
  registerTaskRoutes(app, db, queue);
  registerMessageRoutes(app, db, queue);
  registerEventRoutes(app, db, bus);
  registerRunRoutes(app, db, queue, store);
  registerReviewRoutes(app, db, queue, hosts, store);
  registerWorkerRoutes(app, db, config, queue, store, sources);
  registerBudgetRoutes(app, db);
  registerMcpRoutes(app, db, queue, hosts, mcp, store, spans);
  registerPeterRoutes(app, peter, planners);
  registerStyleRoutes(app, {
    db,
    egress: reach(opts.stylesFetch),
    catalog: opts.styleCatalog ?? STYLE_PACKS,
    vendorDir: opts.stylesVendorDir === undefined ? VENDOR_DIR : opts.stylesVendorDir,
  });
  registerApprovalRoutes(app, db, queue, opts.approvalExecutor ?? brokerExecutor({ db, mcp }));
  registerConnectionRoutes(app, db, mcp, {
    store: secrets,
    oauth: { egress: reach(opts.mcpFetch), log: mcp.log! },
    env: shared,
    publicUrl: config.publicUrl,
    operator,
  });
  registerSecretRoutes(app, db, secrets, config.sharedEnvNames);
  registerProviderRoutes(app, { db, operator, policy: config.modelProviders, egress });
  // What this board can do beyond the basics, for the web to show the right controls. Names only; what the
  // operator lets connections reach goes to the people who manage connections somewhere. The private
  // destinations the operator gave one company alone go to that company's owners and admins only, when the
  // web asks for the company (?companyId=).
  app.get("/api/features", { config: {} }, async (req) => {
    const p = req.principal;
    const manages =
      p.kind === "user" &&
      !!(
        await db.query(
          "SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('owner', 'admin') LIMIT 1",
          [p.actor.id],
        )
      ).rowCount;
    const asked = (req.query as { companyId?: unknown }).companyId;
    const companyId = isUuid(asked) ? asked.toLowerCase() : null;
    const managesCompany =
      manages &&
      companyId !== null &&
      !!(
        await db.query(
          "SELECT 1 FROM memberships WHERE user_id = $1 AND company_id = $2 AND role IN ('owner', 'admin')",
          [p.actor.id, companyId],
        )
      ).rowCount;
    // What the company has alone: an entry every company has too is not shown as its own.
    const own = managesCompany
      ? (config.privateDestinations.companies?.[companyId!]?.entries ?? []).filter(
          (e) => !config.privateDestinations.entries.includes(e),
        )
      : [];
    return {
      oauth: !!secrets,
      objectStore: !!store,
      // Whether the board reads the web: the web connection's pages and research sources.
      web: !!web,
      ...(manages
        ? {
            sharedEnvNames: config.sharedEnvNames,
            stdioCommands: config.stdioCommands.map(stdioCommandLine),
            // The private names, addresses and ranges connections may reach, as the operator wrote them:
            // every company's, then the company's own, which companyPrivateDestinations repeats.
            privateDestinations: [...config.privateDestinations.entries, ...own],
            companyPrivateDestinations: own,
          }
        : {}),
    };
  });
  registerNotifyRoutes(app, notify);
  registerTemplateRoutes(app, db, operator);
  registerDriftRoutes(app, db);
  registerOfficeRoutes(app, db, store);
  const metrics = registerMetrics(app, db, bus, { token: config.metricsToken });
  // Drift: every finished run and every rejection is checked against the teammate's own baseline.
  const stopDrift = startDriftWatch({ db, log: { warn } }, bus);
  // One trace per run, posted when the run ends, when a collector is configured.
  const stopTracer = config.otlp
    ? startRunTracer(
        {
          db,
          target: config.otlp,
          fetch: opts.otlpFetch ?? ((input, init) => fetch(input, init)),
          log: { warn },
        },
        bus,
      )
    : null;

  await bus.start();
  await queue.start();
  // Needs-you events go to the webhook as they land. The notifier is a bus subscriber like Peter's loop.
  const stopNotifier = startNotifier(notify, bus);
  const reaper =
    opts.reaper === false
      ? null
      : startReaper(
          db,
          queue,
          config.reaperIntervalMs,
          { warn },
          { staleAfterMs: config.runStaleAfterMs, orphanAfterMs: 30_000 },
        );

  // Peter's loop: on a timer and on events. Off in tests, where passes run by hand.
  const peterLoop =
    opts.reaper === false || config.peterIntervalMs <= 0
      ? null
      : startPeterLoop(peter, bus, config.peterIntervalMs, { warn }, { chase: peter.chase });

  return {
    app,
    db,
    bus,
    queue,
    peter: peterLoop,
    async close() {
      if (reaper) clearInterval(reaper);
      peterLoop?.stop();
      stopNotifier();
      await mcpPool.closeAll();
      metrics.stop();
      stopDrift();
      stopTracer?.();
      await app.close();
      await bus.stop();
      await queue.stop();
      await db.end();
    },
  };
}
