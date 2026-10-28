# RosterDock

**AI teammates that can't change a live system or merge code without your sign-off.**

[![CI](https://github.com/DawBatteriesNotIncluded/RosterDock/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DawBatteriesNotIncluded/RosterDock/actions/workflows/ci.yml)
[![Licence: Apache 2.0](https://img.shields.io/badge/licence-Apache_2.0-6b675f)](LICENSE)

<!-- The office GIF goes here: docs/images/office.gif, about 15 seconds of a live run in which a goal goes in,
Peter splits it into tasks, teammates sit down at their desks to work and one walks to the owner's room
when it needs an approval. Until it is recorded the still below stands in; then change its path, alt text
and caption. -->

![The Office view of the RosterDock company: the owner's room where approvals wait, reception, a kitchen, a
lounge and the four department rooms (Engineering, Issues & PRs, Docs, Release & Security) with teammates
at their desks and each room's write policy on its name plate](docs/images/office.png)

_[The company that works this repository](#built-by-a-rosterdock-company), at a quiet moment: teammates with
nothing on take a break in the kitchen or the lounge, Peter among them._

RosterDock is a self-hosted platform for departments of AI teammates, each a brain, a persona and a governed
toolbox, working a shared kanban. Peter, the project-manager teammate, plans, chases and re-plans; Claude
Code and Codex teammates do the work. It is for teams that want agents doing real work with a manager,
reviews and an audit trail, on infrastructure they control.

[Quick start](#quick-start-free-on-one-machine) · [Install on Kubernetes](docs/install.md) ·
[Security](docs/security.md) · [Demo companies](#demo-companies) · [Contributing](CONTRIBUTING.md)

## The rules, and the tests that hold them

None of these is a setting, and no role can turn one off. Each names the tests that hold it, and `pnpm test`
runs them all against a local Postgres, with no model, git host or MCP server.

- **Only an approved review marks a task Done.** Nobody can move a task to Done, the owner included, and the
  teammate who did the work cannot approve it. An owner or admin can veto any review, which sends the task
  back to In review. Tests: [`tasks.test.ts`](apps/board/test/tasks.test.ts) "never to Done";
  [`reviews.test.ts`](apps/board/test/reviews.test.ts) "the author never decides", "a veto undoes it".
- **A write to a live system waits for a person.** A teammate proposes the exact payload, an owner or admin
  approves it, and the board sends exactly those bytes, bound by their sha256. A payload that changed after
  it was proposed sends nothing. Tests: [`approvals.test.ts`](apps/board/test/approvals.test.ts)
  "sends exactly the bound bytes", "a payload that drifted after proposal sends nothing".
- **The merge is yours.** An approved review opens a pull request (a merge request on GitLab) with exactly
  the files the review showed, on the commit the run started from. The board's [git code](apps/board/src/git)
  opens and closes pull requests and has no call that merges. Tests:
  [`reviews.test.ts`](apps/board/test/reviews.test.ts) "only from the files the review showed",
  "only on the commit the run's clone was at".
- **Policy only narrows.** A teammate's toolbox is the ceiling: connections in a mode (`read`, `ask` or
  `off`), optionally only some of their tools. A department's or a client's policy can take access away,
  never add it. Tests: [`broker.test.ts`](apps/board/test/broker.test.ts) "policy only narrows";
  [`policy.test.ts`](packages/shared/test/policy.test.ts) "the toolbox is the ceiling".
- **Teammates pass the same guard as people, with less power.** One role guard checks every person and
  teammate, and a teammate cannot create a company, hire a teammate, change the org chart or decide an
  approval. Tests: [`companies.test.ts`](apps/board/test/companies.test.ts) "teammates act as themselves";
  [`roles.test.ts`](packages/shared/test/roles.test.ts) "never on the org chart".
- **Every change is guarded and recorded.** Each mutating route declares the permission it needs, the guard
  refuses one that does not, and each change appends to the company's event stream. Tests:
  [`events.test.ts`](apps/board/test/events.test.ts) "declares a permission action".
- **A credential is a name, never a value.** A key where a name belongs is refused at the write boundary. A
  value set in Settings goes into the secret store; its row and its event keep the name, and no response
  carries the value. Tests: [`companies.test.ts`](apps/board/test/companies.test.ts)
  "rejects raw secret material"; [`company-secrets.test.ts`](apps/board/test/company-secrets.test.ts)
  "no response carries it".
- **Each company is sealed off.** No one outside a company can see it, and its secrets never reach another
  company's connections. Tests: [`companies.test.ts`](apps/board/test/companies.test.ts)
  "non-members are refused"; [`company-secrets.test.ts`](apps/board/test/company-secrets.test.ts)
  "another company's connection never sees the value".

## Built by a RosterDock company

A RosterDock company on the maintainer's board (Engineering, Issues & PRs, Docs, Release & Security, and
Peter) takes tasks in this repository. A reviewer teammate reviews each change, the board opens the pull
request with the reviewed diff's sha256 in it, and a person merges it:
[every pull request the board has opened](https://github.com/DawBatteriesNotIncluded/RosterDock/pulls?q=is%3Apr+%22Merging+needs+a+person%22+in%3Abody).
Most of the history is still the maintainer's.

## RosterDock or Paperclip?

[Paperclip](https://github.com/paperclipai/paperclip) runs a company of AI agents too, and it is the bigger
project. Choose it for breadth: many agent runtimes (OpenClaw, Claude Code, Codex, Cursor, Gemini CLI and
more), routines on a schedule or a webhook, plugins, and a one-command start on a laptop.

Choose RosterDock when the rules matter more than breadth:

- **It runs on your cluster.** A Helm chart installs a stateless board and workers that can scale with the
  queue, behind network policies and your OpenID Connect sign-in. Paperclip has no chart of its own; its
  Kubernetes support is a plugin that runs agents in sandboxes.
- **An approval never becomes a standing rule.** Paperclip also binds an approval to the call's arguments,
  and an operator can then promote it into a trust rule, so the same call runs again without asking. Here
  every live write waits for its own approval.
- **Done means reviewed.** Work reaches Done only through a review: comments on the diff's hunks, checks (a
  secret scan, the repository's tests, cited sources) and a reviewer who is not the author.
- **Nothing phones home.** RosterDock sends no telemetry, and traces go only to a collector you set.
  Paperclip's anonymous usage telemetry is on unless you turn it off.

_Compared in October 2026 from Paperclip's README and docs; corrections are welcome._

## Status

Alpha, with breaking changes to come ([`CHANGELOG.md`](CHANGELOG.md)). Each release is published as three
images and a Helm chart; [`docs/install.md`](docs/install.md) installs one.

Good to know:

- Self-hosted only; engines are Claude Code, Codex and the stub.
- Claude Code on a cluster needs a worker image you build.
- A real install needs Kubernetes 1.27 or later, Postgres 16 and an OpenID Connect provider.

## Quick start: free, on one machine

Requirements: Node.js 22.13 or a later 22, or 24 or later, pnpm 10 (`npm install -g pnpm@10`, or
`corepack enable` on Node 22 or 24) and Docker. On the stub engine, with Peter without a model, nothing calls a
model and nothing costs anything.

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
2. **Teammates > Peter**: under Brain, pick the engine **No model (plans by role)**, so he never plans
   through a `claude` or `codex` CLI that happens to be signed in on this machine.
3. **Teammates > Hire from template**: Ricky (researcher), Brody (requirements) and a third teammate named
   Stubby with the role "n8n engineer", each with the engine **Stub (no model)**.
4. **Company > New goal**: "Send a weekly digest of Gong calls with next steps to #sales every Friday."
   Peter splits it into tasks, the worker runs the research task, and it lands in **Reviews**.

For real models, sign in to a CLI ([Engines](#engines)) and switch a teammate's engine; a company budget in
Settings caps the cost.

### Docker only

`docker compose --profile worker up --build -d` starts Postgres, MinIO, the board, the web and a worker on
http://localhost:8080; follow the same steps. Stub teammates need nothing; the worker is built with Claude
Code and hands Claude Code teammates `ANTHROPIC_API_KEY` from your environment. `docker compose down -v`
deletes the data.

## What it does

- **Teammates** are authors, assignees and reviewers with the same role checks as people; they message and
  delegate.
- **Toolboxes** grant any MCP server or OpenAPI service in a mode (`read`, `ask` or `off`); department and
  project client policies only narrow them.
- **Peter** plans with a model if there is one (perhaps asking questions first), by role if not.
- **Reviews** go hunk by hunk, with checks (secret scan, declared outputs, the repository's tests, cited
  sources, weighted criteria). On GitHub or GitLab an approval opens a pull or merge request; you merge.
- **One event stream** per company feeds activity, the office view and costs; budgets are in tokens; roles
  are owner, admin, reviewer and viewer; sign-in is OpenID Connect.

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

- **board** (`apps/board`): owns state and events, runs Peter, reviews and approvals; alone calls connections.
- **web** (`apps/web`): the React app; nginx proxies `/api` to the board.
- **workers** (`apps/worker`): run engines headless. They run model output, so on a cluster with
  `networkPolicy.enabled` (on in `examples/production.yaml`) they reach only the board, Postgres and public
  HTTPS.
- **Postgres** holds everything; an S3 bucket is optional, for artifacts over 512 KB.

More in the [operator guide](docs/operator.md).

## Engines

Only real engines need anything:

| Engine          | What the worker needs                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| Stub (no model) | Nothing. It writes the task's declared outputs and a handover; no model, no tokens, no cost.                  |
| Claude Code     | The `claude` CLI, signed in (`claude auth login`), or `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for it |
| Codex           | The `codex` CLI, signed in (`codex login`), or `OPENAI_API_KEY` for it                                        |

Peter needs nothing either: without a model he plans by role (research, requirements, build). With
`ANTHROPIC_API_KEY` on the board, or a signed-in `claude` or `codex` CLI where the board runs, he plans
with a model; each company picks his engine on his page under Teammates, as for every teammate. Settings >
Models lists what the board has, and whether each CLI is signed in.

The worker image built from `apps/worker/Dockerfile` carries Codex; Claude Code's licence keeps it out of
public images ([Engines on the worker](docs/install.md#engines-on-the-worker)).

## On Kubernetes

A release's chart installs that release's images, against your Postgres and S3-compatible bucket:

```bash
helm upgrade --install rosterdock oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock --version 0.1.0 \
  -n rosterdock -f my-values.yaml --wait
```

[`docs/install.md`](docs/install.md) takes a fresh cluster there, its Secrets and `my-values.yaml` first.
From a checkout, `deploy/scripts/local-cluster.sh` keeps a kind cluster and `deploy/scripts/smoke.sh` makes a
throwaway install. Guides: [install](docs/install.md), [operator](docs/operator.md),
[security](docs/security.md) and the [docs index](docs/README.md).

## Demo companies

[Lighthouse](deploy/demo/lighthouse/README.md) launches a product, and [Cirrus](deploy/demo/cirrus/README.md),
a telecoms company, recovers from a bad week. Both are invented; their guides set them up and give costs.

![The board of the Lighthouse demo company, with teammates' tasks in columns](docs/images/board.png)

_Lighthouse on the stub engine: tasks to do, running, waiting on a teammate, in review and done._

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup and the rules. Report a security problem privately, as
[`SECURITY.md`](SECURITY.md) says, and see the [code of conduct](CODE_OF_CONDUCT.md).

## Licence

Apache License 2.0: see [`LICENSE`](LICENSE). RosterDock is a dock for your roster of AI teammates.
