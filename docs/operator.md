# Operating RosterDock

The day after the install (`docs/install.md`). What runs where, what to watch, what to do when something
needs you, and how to change the shape of the company from files. The security notes (`docs/security.md`)
say what the platform guarantees.

## What runs

| Component | What it does                                                                                                   | Scales                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| board     | The API, the event stream, Peter's loop, the reaper, the notifier, the tool broker, migrations on boot.        | `board.autoscaling` (HPA on CPU); replicas interchangeable |
| web       | Static files and an nginx proxy for `/api` to the board.                                                       | `web.replicas`                                             |
| worker    | Claims runs from the queue, prepares a workspace, runs the engine, reports usage, artifacts and its pod's CPU. | `worker.autoscaling` (KEDA on queue depth); one per pool   |
| Postgres  | Every row, the queue (pg-boss), sessions, the login attempts. Yours.                                           | yours                                                      |

Only the board talks to the outside: the model API (for Peter), the git host (pull requests), MCP servers
and OpenAPI services (connections), the webhook, the identity provider, the collector. Workers reach the
board, Postgres and, by default, public HTTPS for the model API and the git host; a pool can reach less.

## Watching it

- **The Company page** is the operator's first screen: goals, drafts, the live rail (who is running,
  what step, elapsed time, tokens, and the pod's CPU and memory), Needs-you.
- **Worker metrics.** Each worker serves `/metrics` on its own port (`worker.metrics.port`, default 9464):
  the worker and its pool, runs finished by outcome, seconds on runs, whether one is in flight, when the
  last ended. The pod is annotated for scraping; with `observability.serviceMonitor.enabled` a
  ServiceMonitor covers the fleet through the headless `-workers` Service. The network policy opens that
  port only, to `networkPolicy.worker.metricsFrom` (anyone in the cluster when empty).
- **Metrics.** `/metrics` on the board: requests and durations by route, events by type, runs finished by
  status with durations and tokens, tool calls, approvals, and live gauges (runs live, approvals pending,
  tasks by status); behind a bearer when `board.metricsSecret` is set. Alert on
  `rosterdock_runs_live{status="interrupted"}` staying above zero, on
  `rosterdock_approvals_pending` climbing, on `rosterdock_runs_total{status="failed"}` rising faster than
  `completed`, and on the board's readiness.
- **Traces.** One per run in your collector, named by the run's uuid: the queue wait, each step, each tool
  call, and the worker's workspace, engine, harvest and tests spans. A slow run is one trace to open.
- **Logs.** JSON lines from both the board and the worker. Search by `runId`, by `req.id`, by `worker`.
- **Costs.** The Costs page per company: this week or month by department, project, teammate and model,
  the monthly report by chargeback tag, and the CSVs for finance. Budgets alert at 80% and 100%.
- **Drift.** A teammate whose runs suddenly cost or take far more than their own usual, or whose work is
  sent back far more often, raises one alert per day: in Activity, in the notifications, on their page.
  Nothing stops; open their recent runs and reviews and decide. What counts as "far more" is the
  company's to set in Settings (Drift): times the usual, the spread, the rejection rate and its rise.

## When something needs you

Everything that needs a person is one sentence in the webhook (`board.notifySecret`, or a per-company env
var name in Settings) and a row in the Approvals or Company page:

| Sentence                                   | What to do                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| A teammate asks approval to write …        | Approvals: read the exact payload and its hash; Approve and run, or Reject with a note (Peter re-plans). |
| The approved write could not be sent       | The connection is off, gone or refusing: Settings, Connections; fix and let the teammate propose again.  |
| Peter has questions before planning …      | The goal card: answer them; Peter plans.                                                                 |
| Peter needs you on … (a goal turned amber) | The goal card: a task failed three times; read the runs, fix the brief or the toolbox, restart the task. |
| Pull request opened for …                  | Merge it (or not) on the git host; merging is yours by design.                                           |
| Budget alert                               | Settings: raise the budget, or leave it and let runs wait at the gate.                                   |
| Peter proposes … / audited …               | The Company page: accept or decline the draft.                                                           |
| … runs cost 3× their usual                 | The teammate's page and their last runs; a bigger model, a bigger task, or a loop. Nothing stopped.      |

## Runs that go wrong

- **Interrupted.** A worker stopped heartbeating (the pod died, the node drained). The reaper marks the
  run interrupted after `ROSTERDOCK_RUN_STALE_AFTER_MS` (60 s) and pg-boss retries the job; a retry that finds
  the run reaped resumes from the checkpoint. After five retries the task lands in Blocked with the
  reason, and Peter re-plans it.
- **Stuck queued.** No worker is taking the queue: check the worker pods, their `DATABASE_URL` and
  `ROSTERDOCK_WORKER_TOKEN` (must equal the board's), and, for a pooled department, that a fleet with
  `ROSTERDOCK_WORKER_POOL=<pool>` exists. `rosterdock_runs_live{status="queued"}` shows it.
- **Failed at once with "Claude Code is not installed on this worker"**: the published worker image leaves
  Claude Code out. Build the image with it and set `worker.image` (`docs/install.md`, Engines on the
  worker), or move the teammate to Codex.
- **Failed at once with "no engine adapter"**: the teammate's engine is not on that worker image
  (`stub`, `claude_code` and `codex` ship; `opencode` does not yet).
- **Stop a run.** The run panel's Stop: a queued run stops at once; a running one at its next heartbeat.

## Changing the company from files

Settings, Templates: **Export as a file** writes the company's shape (teammate templates, teammates
with personas and toolboxes, departments with leads, members, sandbox and pool) as one JSON document.
**Import a file** into any company creates what is missing and leaves what exists; the report says what
happened and what could not be honoured (a connection the company does not have, an engine that is not
enabled). The shipped examples are `deploy/templates/gtm-company.json` and `finance-department.json`;
the format is `rosterdock/templates/1` (`TemplatesFileSchema` in `@rosterdock/shared`). Files carry names,
never credential values: a persona or a playbook that carries one is refused whole.

## Worker pools

A department that must reach less than the default fleet gets its own: declare `worker.pools[]` in the
chart with its egress (an empty list reaches only the board and Postgres), and set `pool` on the
department's sandbox ("Runs on" when creating it, or PATCH `sandbox.pool`). Its runs queue on
`runs.<pool>` and only that fleet takes them. A pool may run its own worker image (`image:` on the pool,
a full reference) for a fleet on another engine build or a pinned tag; without one it runs `worker.image`,
else the chart's. Check `rosterdock_runs_live` and the fleet's pods when such a department's tasks sit queued.

## Upgrades and backups

- Upgrade by naming the next chart version (`docs/install.md`, Upgrading). The chart's version is its
  images' tag, so nothing moves until you name one; pin `image.tag` to a version if you set it, never
  `latest`. Read the version's entry in `CHANGELOG.md` first: before 1.0 a minor version may break
  something, and the entry says what and what to do.
- The board applies migrations on boot, serialised across replicas. They are forward-only: `helm rollback`
  puts the old board on the new schema, so back up Postgres before an upgrade and restore that backup if
  you go back.
- A worker image you built with Claude Code (`worker.image`) is built again from the new version's image
  and moved in the same upgrade, so every worker runs the board's version; the same for a pool's `image:`.
- Back up Postgres. It holds everything: rows, events, sessions, the queue. The bucket holds artifacts
  over 512 KB, addressed from their rows by key; back it up with Postgres or accept that a restore
  reads those as missing.
- Rotate a credential by changing the Secret and restarting the deployment that reads it; nothing on the
  board stores a value, so nothing else changes.
- From a board that let companies reach its own environment (before `ROSTERDOCK_SHARED_ENV_NAMES`), four
  things are closed by default. A connection or notification name whose value lives on the board pod
  (`board.connectionsSecret`, compose's `environment:`) resolves for companies only once
  `board.sharedEnvNames` lists it; a credential meant for one company goes in that company's Settings >
  Connections > Secrets instead (with `board.oauth.enabled`). A stdio connection starts only once
  `board.stdioCommands` lists its command line; until then its discovery is refused (403), its check and
  its calls fail, and it can still be switched off or removed. Only the people `board.companyCreators`
  lists create companies, besides the first on an empty board. And a public sign-in provider (Google and
  the like) with no `board.oidc.allowedDomains` does not start: list your domains, or `"*"`.

## Environment reference

The board reads `apps/board/.env.example`'s names; the chart sets them from values and Secrets. The ones
an operator changes:

| Name                                         | Meaning                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROSTERDOCK_DEV_LOGIN`                       | Off in production.                                                                                                                                                                                                                                                                                                                                                     |
| `ROSTERDOCK_SECRET_STORE`                    | A secret store the board may write to: the tokens a connection's OAuth flow obtains, and the values people set under Settings > Connections > Secrets (`rosterdock-company-<id>`, one key per name; resolved for that company before the shared names). `kubernetes` (the chart sets it with `board.oauth.enabled`) or `file:<dir>`. Unset: only shared names resolve. |
| `ROSTERDOCK_SHARED_ENV_NAMES`                | Env var names on the board every company may name besides its own secrets (chart `board.sharedEnvNames`), comma-separated; nothing else on the board reaches a company. Any company's admins can send a shared value anywhere, so share only what every company may hold; the board will not start with one of its own names (`docs/security.md`). Empty: none.        |
| `ROSTERDOCK_STDIO_COMMANDS`                  | The command lines a stdio connection may run inside the board (chart `board.stdioCommands`), comma-separated: the command and its arguments, matched exactly; a final `*` lets a company add arguments. The server runs as the board and reads what it can, so list only what every company's admins may run (`docs/security.md`). Empty: none runs.                   |
| `ROSTERDOCK_COMPANY_CREATORS`                | Who may create a company (chart `board.companyCreators`): emails and `@domain`s, comma-separated, or `*` for anyone who signs in. Unset: the first person to create one on an empty board owns it and nobody creates another (with the dev login on, anyone may). Everyone else joins a company when an owner invites their email.                                     |
| `ROSTERDOCK_OIDC_*`, `ROSTERDOCK_PUBLIC_URL` | Sign-in (`docs/install.md`).                                                                                                                                                                                                                                                                                                                                           |
| `ROSTERDOCK_GITLAB_TOKEN`                    | Opens merge requests on GitLab projects after an approved review; `ROSTERDOCK_GITLAB_API` names a self-hosted API root (default `https://gitlab.com/api/v4`).                                                                                                                                                                                                          |
| `ROSTERDOCK_NOTIFY_WEBHOOK_URL`              | Needs-you notifications; a Slack incoming webhook works as is.                                                                                                                                                                                                                                                                                                         |
| `ROSTERDOCK_NOTIFY_SMTP_URL`                 | Needs-you notifications by email: `smtp://` or `smtps://` with the credentials inside; with `ROSTERDOCK_NOTIFY_EMAIL_TO` (comma-separated) and `_FROM`.                                                                                                                                                                                                                |
| `ROSTERDOCK_PETER_INTERVAL_MS`               | How often Peter's loop passes over every company; 0 disables it.                                                                                                                                                                                                                                                                                                       |
| `ROSTERDOCK_RUN_STALE_AFTER_MS`              | How long a silent run is left before the reaper interrupts it.                                                                                                                                                                                                                                                                                                         |
| `ROSTERDOCK_DB_POOL_MAX`                     | Postgres connections per board replica (the board and the queue).                                                                                                                                                                                                                                                                                                      |
| `OTEL_EXPORTER_OTLP_*`                       | Traces.                                                                                                                                                                                                                                                                                                                                                                |
| Worker: `ROSTERDOCK_WORKER_POOL`             | Which queue this fleet consumes.                                                                                                                                                                                                                                                                                                                                       |
| Worker: `ROSTERDOCK_ENGINE_PASS_ENV`         | Env var NAMES handed to the engine process.                                                                                                                                                                                                                                                                                                                            |
| Worker: `ROSTERDOCK_RUN_REPO_TESTS`          | Run the repository's tests after the harvest (a review check).                                                                                                                                                                                                                                                                                                         |
| Worker: `ROSTERDOCK_POD_METRICS`             | Read the pod's CPU and memory from the metrics API instead of the cgroup (the chart sets it with `worker.podMetrics.enabled`, with the token and the Role it needs).                                                                                                                                                                                                   |
| Worker: `ROSTERDOCK_LOG_FORMAT`              | `json` (default in a cluster) or `text`.                                                                                                                                                                                                                                                                                                                               |
