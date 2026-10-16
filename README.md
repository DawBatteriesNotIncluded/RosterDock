# RosterDock

RosterDock is a self-hosted platform for running a company of AI teammates. You set up departments staffed by
teammates, each with a brain (Claude Code or Codex and a model), a persona and a toolbox of governed
connections. Peter, the project-manager teammate, turns a goal into tasks, assigns them by role and load,
chases what is stuck and re-plans what fails. Teammates work in parallel on a shared kanban, message and
delegate to each other, and review each other's work hunk by hunk. People gate two things only: merges to
protected branches and writes to live external systems. It runs on your own Kubernetes cluster from a Helm
chart, or on one machine for development.

It is for teams that want AI agents doing real work (research, code, content, operations) as a team with a
manager, reviews, budgets and an audit trail, on infrastructure they control, with a person deciding
everything that leaves it.

![The board of the Lighthouse demo company: AI teammates' tasks to do, running, blocked on a teammate, in review and done](docs/images/board.png)

_The Lighthouse demo company on the dev stack, every teammate on the stub engine._

## Status

Alpha, version 0.x. The board, the workers, Peter, reviews, approvals and the chart work end to end, and the
test suite runs offline, but expect breaking changes between versions and rough edges. Pin a version, and read
its entry in [`CHANGELOG.md`](CHANGELOG.md) before upgrading.

## What it does

- **Teammates** are first-class actors: authors, assignees and reviewers with the same role checks as people.
  A toolbox grants each one connections (MCP servers, OpenAPI services) in a mode (`read`, `ask` or `off`);
  department and project client policies only ever narrow it.
- **Peter** plans every goal: with a model when one is available (and then he may ask questions first), by
  role when not. He re-plans a failed task with a note and turns the goal amber when it needs you.
- **Reviews**: every finished task opens a review with checks (secret scan, declared outputs, the
  repository's tests, cited sources, weighted criteria), decided by a reviewer teammate or a person. Only an
  approved review marks a task Done, and a person can veto it. On a GitHub or GitLab project the approval
  opens a pull or merge request; merging stays with you.
- **Approvals**: a write to a live system is proposed with the exact payload and its sha256, and runs only
  after a person approves that payload.
- **One event stream** per company behind the activity feed, the office view and the costs; budgets per
  company, department, project and teammate; roles (owner, admin, reviewer, viewer); sign-in through OpenID
  Connect.

## How it fits together

```text
browser ──▶ web ──/api──▶ board ──────▶ connections (MCP, OpenAPI), git hosts, webhooks
                          ▲   │
            claim runs,   │   │ state, events
            events, files │   ▼
                       workers ──────▶ Postgres (every row, the events, the run queue)
                          │
                          ▼
                      model API
```

- **board** (`apps/board`): the API, which owns all state and the event stream. Node 22, Fastify,
  Postgres. It runs Peter's loop, the review checks, the tool broker and approvals, and the notifications,
  and applies migrations on boot. It alone calls connections, opens pull requests and sends notifications.
- **web** (`apps/web`): the React app, served by nginx, which proxies `/api` to the board.
- **workers** (`apps/worker`): each claims a run from the queue, prepares a workspace (a clone of the
  project's repository, if it has one), runs the teammate's engine headless and streams events and files
  back. They run model output, so on a cluster their network policy lets them reach the board, Postgres and
  public HTTPS (the model API, the git host), and nothing private.
- **Postgres** holds everything: rows, events, sessions and the queue. An S3 bucket is optional, for
  artifacts over 512 KB.

## Prerequisites

- Node.js 22.12 or later and pnpm 10 (`corepack enable` picks the pinned version)
- Docker, for Postgres in development and for the test suite
- For a cluster: Kubernetes 1.27 or later and Helm 3.8 or later (see [`docs/install.md`](docs/install.md))

Each teammate runs on an engine, and only real engines need anything:

| Engine          | What the worker needs                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| Stub (no model) | Nothing. It writes the task's declared outputs and a handover; no model, no tokens, no cost.                  |
| Claude Code     | The `claude` CLI, signed in (`claude auth login`), or `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for it |
| Codex           | The `codex` CLI, signed in (`codex login`), or `OPENAI_API_KEY` for it                                        |

Peter needs nothing either: without a model he plans by role (research, requirements, build). With
`ANTHROPIC_API_KEY` on the board, or a signed-in `claude` or `codex` CLI where the board runs, he plans with a
model; each company chooses in Settings > Peter. On a cluster, the published worker image carries Codex but
not Claude Code, whose licence keeps it out of a public image; the install guide shows how to add it in an
image of your own ([Engines on the worker](docs/install.md#engines-on-the-worker)).

## Quick start: free, on one machine

The stub engine and Peter without a model: nothing calls a model and nothing costs anything.

```bash
git clone https://github.com/DawBatteriesNotIncluded/RosterDock.git
cd RosterDock
pnpm install
cp apps/board/.env.example apps/board/.env
cp apps/worker/.env.example apps/worker/.env
pnpm db:up          # Postgres, and MinIO for artifacts over 512 KB
pnpm db:migrate
pnpm dev
```

The board is on port 3000 and the web on http://localhost:5173. In a second terminal, start a worker (it runs
one teammate at a time):

```bash
pnpm dev:worker
```

Then, in the browser:

1. Sign in with any email and create a company; Peter is seated with it. The dev login lets anyone who
   reaches the board sign in as anyone and create companies, so it stays on this machine: a real install
   signs in through your identity provider and names who may create companies (`docs/install.md`).
2. **Settings > Peter**: pick **No model**, so he never plans through a `claude` or `codex` CLI that happens
   to be signed in on this machine.
3. **Teammates > Hire from template**: Ricky (researcher), Brody (requirements) and a third teammate named
   Stubby with the role "n8n engineer", each with the engine **Stub (no model)**.
4. **Company > New goal**: "Send a weekly digest of Gong calls with next steps to #sales every Friday."
   Peter splits it into tasks, the worker runs the research task, and it lands in **Reviews**.

To use real models, sign in to a CLI from the table above and switch a teammate's engine. What a goal costs
then depends on the models and the review rounds; the demo guides list measured figures
([Lighthouse](deploy/demo/lighthouse/README.md), [Cirrus](deploy/demo/cirrus/README.md)), and a company
budget in Settings caps it.

### The whole stack in Docker

`docker compose up --build -d` builds and starts Postgres, MinIO, the board and the web on
http://localhost:8080, with every port published on 127.0.0.1 only, since the stack runs with the dev login
on. It starts no worker: add `--profile worker` to build and start one with Claude Code (it hands
`ANTHROPIC_API_KEY` from your environment to Claude Code teammates; stub teammates need nothing).

## On Kubernetes

Each release publishes the three images and the chart to GHCR, and [`CHANGELOG.md`](CHANGELOG.md) says what
it changed.

- [`docs/install.md`](docs/install.md): a fresh cluster to a working board, with a first demo
- [`docs/operator.md`](docs/operator.md): what to watch and what to do once it runs
- [`docs/security.md`](docs/security.md): what the platform guarantees and what it needs from you

Two demo companies show it doing real work: [Lighthouse](deploy/demo/lighthouse/README.md) launches a product,
and [Cirrus](deploy/demo/cirrus/README.md), a telecoms company, recovers from a bad week.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup and the rules for a change. The plan is
[`docs/plan.html`](docs/plan.html) and the visual spec [`docs/prototype.html`](docs/prototype.html). Report a
security problem privately, as [`SECURITY.md`](SECURITY.md) says, and see the
[code of conduct](CODE_OF_CONDUCT.md).

## Licence

Apache License 2.0: see [`LICENSE`](LICENSE). RosterDock is a dock for your roster of AI teammates.
