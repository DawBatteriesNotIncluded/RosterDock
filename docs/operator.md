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
  the monthly report by chargeback tag, and the CSVs for finance. Budgets alert at 80% and 100%. A Claude
  Code run that is stopped or hits its time limit counts what its messages reported (the output of the
  last one may be short); Codex reports tokens only at the end, so a stopped Codex run counts none, and
  its run log says so. A run on the stub engine counts under the stub, whatever model its teammate names:
  it called none, so it has no price.
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

A task waiting on a person is amber on the board, "Needs you", and turns its goal amber (a task outside any
open goal gets Peter's "Needs a person" note on it instead). A teammate's blocker names who it waits on by
handle; a name that is no teammate here (`@manager`, someone's first name) is a person. A wait on the task's
manager, on Peter or on a teammate that no longer exists goes to a person once `ROSTERDOCK_CHASE_BLOCKED_FOR_MS`
(10 min) has passed, and so does a wait on a teammate who has not answered that long after Peter chased them
(he chases once). Give the task what it asks for, then **Unblock** it: its goal carries on.

A teammate's pull request (a merge request on GitLab) is one commit on the branch `rosterdock/task-12`,
titled `Task 12: <the task's title>`. Its body names the round, the reviewer who approved it, the checks and
the diff's sha256. The board never writes a bare `#12`: the git host would link that to the repository's
own issue or pull request 12. Only build work on a project with a repository opens one; research documents
stay on the board. **New goal** puts a goal in a project that exists, or opens one on the repository URL and
branch you give it, and Peter plans changes to code only on a project that has one. A task filed into a
project after the goal that opened it closed is work outside that goal.

A write a person rejects leaves its task Blocked on the rejection, with the note: nothing waits for a decision
any more, and Peter re-plans a teammate's task without that write. A task nobody will finish is cancelled from
its status menu (owners and admins); a cancelled task is reopened from Details.

## Runs that go wrong

- **Interrupted.** A worker stopped heartbeating (the pod died, the node drained). The reaper marks the
  run interrupted after `ROSTERDOCK_RUN_STALE_AFTER_MS` (60 s) and pg-boss retries the job; a retry that finds
  the run reaped resumes from the checkpoint. After five retries the task lands in Blocked with the
  reason, and Peter re-plans it. A worker that is shut down (a drain, a rollout) stops its engine, stores
  what the run wrote and its checkpoint, and leaves the run to that retry; it never reports it stopped.
- **Stuck queued.** No worker is taking the queue: check the worker pods, their `DATABASE_URL` and
  `ROSTERDOCK_WORKER_TOKEN` (must equal the board's), and, for a pooled department, that a fleet with
  `ROSTERDOCK_WORKER_POOL=<pool>` exists. `rosterdock_runs_live{status="queued"}` shows it.
- **"Round N's changes did not carry over to this run"** on a task. An author sent back with changes
  requested on a repository starts from that round: the worker applies the review's `changes.diff`, checked
  against the sha256 the review recorded, to its fresh clone, and the next round's diff is still taken
  against the base branch, so the review's hunks and the pull request hold the whole change. When the base
  branch moved and the round no longer applies, or it holds a binary file (the review's diff carries no
  bytes for one) or a symbolic link (never carried over), the run starts from the clean clone instead; the
  run log, its handover and that message name the files, and the teammate makes the change again on the
  current branch.
- **Failed at once with "Claude Code is not installed on this worker"**: the published worker image leaves
  Claude Code out. Build the image with it and set `worker.image` (`docs/install.md`, Engines on the
  worker), or move the teammate to Codex.
- **Failed at once with "no engine adapter"**: the teammate's engine is not on that worker image
  (`stub`, `claude_code` and `codex` ship).
- **Failed at once with "Codex cannot keep to <department>'s tool list"**: the department's tool list leaves
  out Bash, or allows only some shell commands, and Codex reads files and runs commands only through its
  shell. Nothing started: no clone, no Codex. Name Bash on its own in the list (Codex's own sandbox still
  holds it to the rest of the list, `docs/security.md`), or give the work to a Claude Code teammate. The
  board refuses to seat a Codex teammate in such a department; Peter's audit names one seated before.
- **"runs on opencode, which is not available"**: OpenCode has no worker yet, so the board starts no run on it
  and the pickers no longer offer it. Pick another engine in the teammate's editor.
- **Failed with "git clone failed"**: the project's repository URL or branch, or the worker's git token
  (`worker.gitSecret`). The token goes only to the hosts in `worker.gitSecret.hosts` (github.com unless you
  list others), so a private repository on GitLab or GitHub Enterprise Server needs its host listed there.
  A clone that moves under 1 KB a second for a minute gives up, and the run's time limit counts from the
  start of the clone.
- **The board was down when a run finished.** The worker retries the report for about five minutes,
  heartbeating meanwhile, then leaves the run to pg-boss's retry, which runs it again. A report the board
  refuses outright is replaced by a failed run that says why.
- **Stop a run.** The run panel's Stop: a queued run stops at once; a running one at its next heartbeat,
  a clone in progress included.

## Changing the company from files

Settings, Templates: **Export as a file** writes the company's shape (teammate templates, teammates
with personas and toolboxes, departments with leads, members, sandbox and pool) as one JSON document.
**Import a file** into any company creates what is missing and leaves what exists; the report says what
happened and what could not be honoured (a connection the company does not have, an engine that is not
enabled). The shipped examples are `deploy/templates/gtm-company.json` and `finance-department.json`;
the format is `rosterdock/templates/1` (`TemplatesFileSchema` in `@rosterdock/shared`). Files carry names,
never credential values: a persona or a playbook that carries one is refused whole. The teammate templates
a file brings are the company's own: Hire lists them after the built-in ones
(`GET /api/companies/:companyId/templates/teammates`), and no other company sees them;
`GET /api/templates/teammates` serves only the built-in ones.

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

The board reads `apps/board/.env.example`'s names; the chart sets them from values and Secrets, and a board
setting with no value of its own from `board.extraEnv`. The ones an operator changes:

| Name                                         | Meaning                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROSTERDOCK_DEV_LOGIN`                       | Off in production.                                                                                                                                                                                                                                                                                                                                                     |
| `ROSTERDOCK_SECRET_STORE`                    | A secret store the board may write to: the tokens a connection's OAuth flow obtains, and the values people set under Settings > Connections > Secrets (`rosterdock-company-<id>`, one key per name; resolved for that company before the shared names). `kubernetes` (the chart sets it with `board.oauth.enabled`) or `file:<dir>`. Unset: only shared names resolve. |
| `ROSTERDOCK_SHARED_ENV_NAMES`                | Env var names on the board every company may name besides its own secrets (chart `board.sharedEnvNames`), comma-separated; nothing else on the board reaches a company. Any company's admins can send a shared value anywhere, so share only what every company may hold; the board will not start with one of its own names (`docs/security.md`). Empty: none.        |
| `ROSTERDOCK_STDIO_COMMANDS`                  | The command lines a stdio connection may run inside the board (chart `board.stdioCommands`), comma-separated: the command and its arguments, matched exactly; a final `*` lets a company add arguments. The server runs as the board and reads what it can, so list only what every company's admins may run (`docs/security.md`). Empty: none runs.                   |
| `ROSTERDOCK_COMPANY_CREATORS`                | Who may create a company (chart `board.companyCreators`): emails and `@domain`s, comma-separated, or `*` for anyone who signs in. Unset: the first person to create one on an empty board owns it and nobody creates another (with the dev login on, anyone may). Everyone else joins a company when an owner invites their email.                                     |
| `ROSTERDOCK_OIDC_*`, `ROSTERDOCK_PUBLIC_URL` | Sign-in (`docs/install.md`).                                                                                                                                                                                                                                                                                                                                           |
| `ROSTERDOCK_SESSION_TTL_SECONDS`             | How long a sign-in lasts (default 30 days).                                                                                                                                                                                                                                                                                                                            |
| `ROSTERDOCK_SIGNIN_RATE_LIMIT`               | Requests a minute one client address may make to each sign-in route, per board replica (default 60, 0 off; chart `board.signInRateLimit`). Wider limits belong at the ingress (`docs/security.md`).                                                                                                                                                                    |
| `ROSTERDOCK_GITHUB_TOKEN`                    | Opens pull requests on GitHub after an approved review; `ROSTERDOCK_GITHUB_API` names a GitHub Enterprise Server API root (chart `board.githubApi`).                                                                                                                                                                                                                   |
| `ROSTERDOCK_GITLAB_TOKEN`                    | Opens merge requests on GitLab projects after an approved review; `ROSTERDOCK_GITLAB_API` names a self-hosted API root (default `https://gitlab.com/api/v4`).                                                                                                                                                                                                          |
| `ROSTERDOCK_NOTIFY_WEBHOOK_URL`              | Needs-you notifications; a Slack incoming webhook works as is.                                                                                                                                                                                                                                                                                                         |
| `ROSTERDOCK_NOTIFY_SMTP_URL`                 | Needs-you notifications by email: `smtp://` or `smtps://` with the credentials inside; with `ROSTERDOCK_NOTIFY_EMAIL_TO` (comma-separated) and `_FROM`.                                                                                                                                                                                                                |
| `ROSTERDOCK_PETER_INTERVAL_MS`               | How often Peter's loop passes over every company; 0 disables it.                                                                                                                                                                                                                                                                                                       |
| `ROSTERDOCK_RUN_STALE_AFTER_MS`              | How long a silent run is left before the reaper interrupts it.                                                                                                                                                                                                                                                                                                         |
| `ROSTERDOCK_DB_POOL_MAX`                     | Postgres connections per board replica (the board and the queue).                                                                                                                                                                                                                                                                                                      |
| `ROSTERDOCK_FETCH_SOURCES`                   | `0` keeps the board off the web: a research reviewer gets no fetched sources (chart `board.fetchSources: false`).                                                                                                                                                                                                                                                      |
| `OTEL_EXPORTER_OTLP_*`                       | Traces.                                                                                                                                                                                                                                                                                                                                                                |
| Worker: `ROSTERDOCK_WORKER_POOL`             | Which queue this fleet consumes.                                                                                                                                                                                                                                                                                                                                       |
| Worker: `ROSTERDOCK_HEARTBEAT_MS`            | How often a running run tells the board it is alive (15000). Keep it well under `ROSTERDOCK_RUN_STALE_AFTER_MS`, or the board takes the run over (chart `worker.extraEnv`).                                                                                                                                                                                            |
| Worker: `ROSTERDOCK_ENGINE_PASS_ENV`         | Env var NAMES handed to the engine process.                                                                                                                                                                                                                                                                                                                            |
| Worker: `ROSTERDOCK_GIT_TOKEN_HOSTS`         | The git hosts the worker's git token (`ROSTERDOCK_GIT_TOKEN`) is sent to, comma-separated, with a port where it is not 443 (chart `worker.gitSecret.hosts`). Default `github.com`; a repository on any other host clones without the token.                                                                                                                            |
| Worker: `ROSTERDOCK_CLAUDE_ALLOWED_TOOLS`    | The most a Claude Code teammate may use (chart `worker.claudeAllowedTools`, per pool too). A department's sandbox only narrows it: Lighthouse's Research names WebSearch and WebFetch, which run only on a fleet that lists them.                                                                                                                                      |
| Worker: `ROSTERDOCK_CODEX_SANDBOX`           | The widest sandbox Codex runs in: `workspace-write` (default), `read-only`, or `danger-full-access` for a pod that is sandboxed already (chart `worker.extraEnv`). A department's tool list only narrows it, and a list Codex cannot keep to stops its runs (`docs/security.md`). A mode Codex does not know stops the worker at start.                                |
| Worker: `ROSTERDOCK_RUN_REPO_TESTS`          | Run the repository's tests after the harvest (a review check). The test script gets PATH, HOME, the temp directory, the locale and `CI=1`: no model key, board token or git token, so a private registry install fails there. `0` turns it off (chart `worker.extraEnv`; `docs/security.md`).                                                                          |
| Worker: `ROSTERDOCK_POD_METRICS`             | Read the pod's CPU and memory from the metrics API instead of the cgroup (the chart sets it with `worker.podMetrics.enabled`, with the token and the Role it needs).                                                                                                                                                                                                   |
| Worker: `ROSTERDOCK_LOG_FORMAT`              | `json` (default in a cluster) or `text` (chart `worker.extraEnv`).                                                                                                                                                                                                                                                                                                     |
