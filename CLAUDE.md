# RosterDock

RosterDock is a self-hosted, Kubernetes-native platform for running an AI company: departments staffed by
AI teammates (brain + persona + governed MCP toolbox), a project-manager teammate (Peter) that plans and
re-plans, a shared kanban, agent-to-agent messaging and hunk-level review. Humans gate only merges to
protected branches and writes to live external systems. Ships as a Helm chart.

The plan is `docs/plan.html`. The visual spec is `docs/prototype.html` (one self-contained file; open it in a
browser). The plan changes only in that document, never in a chat message.

## Layout

| Path                     | What                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `apps/board`             | Board API. Node 22, TypeScript, Fastify, Postgres. Owns all state, the event stream, roles.                           |
| `apps/web`               | Web UI. React, Vite, Tailwind. The prototype tokens are the theme.                                                    |
| `apps/worker`            | Worker image. Claims runs, runs an engine headless, streams events.                                                   |
| `packages/shared`        | Pure, offline-testable code shared by every app: secrets guard, hashing, blockers, roles, event fan-out, API schemas. |
| `deploy/helm/rosterdock` | Helm chart. `examples/production.yaml` is the starting values file.                                                   |
| `deploy/templates`       | Importable company and department template files (`rosterdock/templates/1`).                                          |
| `deploy/demo`            | The demo companies' seed drives and guides (Lighthouse, Cirrus); `deploy/scripts/demo.mjs` sets one up on a board.    |
| `deploy/scripts`         | `smoke.sh`: a throwaway install that checks the chart answers; `local-cluster.sh`: a kind cluster that stays.         |
| `docs/`                  | Plan, prototype, the install, operator and security guides, backlog, and the milestones' design notes.                |

## Commands

```bash
pnpm install                      # once
pnpm db:up                        # Postgres 16 + MinIO in Docker (ports 5432, 9000/9001)
pnpm db:migrate                   # apply apps/board/migrations to DATABASE_URL
pnpm dev                          # board on :3000 and web on :5173 (web proxies /api to the board)
pnpm dev:worker                   # a worker consuming the runs queue (engines: stub, claude_code, codex); needs apps/worker/.env
pnpm typecheck && pnpm lint       # every package
pnpm format:check                 # Prettier, as CI runs it; pnpm format writes
pnpm test                         # offline; board tests need Postgres from db:up (they create throwaway databases)
pnpm compose:up                   # the whole thing: postgres, minio, board, web on http://localhost:8080
helm lint deploy/helm/rosterdock --set postgres.externalSecret.name=rosterdock-db
deploy/scripts/smoke.sh           # build the images, install into rosterdock-smoke on the current kubectl context, curl the board
deploy/scripts/local-cluster.sh   # a kind cluster rosterdock that stays: Postgres on a volume, the chart with examples/local.yaml
```

The guides: `docs/install.md` (a fresh cluster to a working board), `docs/operator.md` (the day after),
`docs/security.md` (what the platform guarantees and what you own).

`docs/m0.md` to `docs/m6.md` are the plan's milestones, each with its design notes and demo script.

Environment for the board lives in `apps/board/.env.example`. Copy it to `apps/board/.env` for local dev.
Dev login is on only when `ROSTERDOCK_DEV_LOGIN=1`.

## Rules that never soften

- Autonomy by default. Human gates only for merges and live external writes.
- Secrets are env-var names or secret refs only. Never values in Postgres, events, logs or responses.
  A person may set a value from Settings: it enters once, write-only, into the board's secret store under
  the company and the name (`PUT /secrets/:name`, the one route whose body carries a value) and resolves
  for that company before the names the operator shares (`ROSTERDOCK_SHARED_ENV_NAMES`); nothing else in the
  board's environment ever resolves for a company. `assertNoRawSecrets` from `@rosterdock/shared` runs at
  every other write boundary.
- External writes are propose, approve, execute, with a sha256 binding of the exact payload.
- Teammates never mark Done. An approved review does. Humans can veto any review.
- Policy only narrows: teammate toolbox is the ceiling (a connection with a mode, optionally only some of its
  tools); department policy and project client policy tighten it.
- One event stream. Activity, office and map are projections of the `events` table. No visualisation-only events.
- Everything is per company: every row carries `company_id`; approvals, Needs-you, activity, budgets, costs are per company.
- Roles from day one: owner, admin, reviewer, viewer, teammate. Every mutating route goes through one guard
  (a company route declares `config.action`; `registerGuard` in `apps/board/src/auth/guard.ts` checks it
  against the role matrix in `@rosterdock/shared` and fails closed on a route without one) and appends an
  event in the same transaction (`mutate` in `apps/board/src/mutate.ts` rolls back a mutation that appended
  none).
- Teammates are first-class actors: every author, assignee, reviewer and actor field is `(kind, id)` where kind is
  `user` or `teammate`, and the same guard applies to both.
- Offline test suite. No test needs a model, a git host or an MCP server. Protocol adapters are tested against
  recorded fixtures, never hand-written echoes. `global.fetch` is mocked, never real.
- Manager language on the surface: names, tasks, conversations, reviews, approvals. No lanes, leases, run specs
  or blocker codes in the UI.

## Design direction (settled)

Warm neutral ground `#f6f5f2`, surface `#ffffff`, border `#e6e3dc`, ink `#1c1b19`, muted `#6b675f`.
Green `#1f7a5c` means only "an agent is working". Amber `#c98a1c` means only "needs you". Red `#b3261e` is
blocked. Blue `#4f6bd8` is review or mention. Both themes required. Fonts: Schibsted Grotesk (UI), IBM Plex Mono
(ids, diffs, numbers). 8px card radius, 6px control radius. The full token set is in `apps/web/src/styles/tokens.css`
and must match `docs/prototype.html`.

## Working agreement

- Small reviewable slices. Each slice is green (`typecheck`, `lint`, `format:check`, `test`) and committed before the next.
- One writer on the tree at a time. Verify the baseline yourself before changing anything.
- One milestone at a time. Anything outside the current milestone goes in `docs/backlog.md`, not in the tree.
- A route or concept lands with its doc line in the same commit, or it does not land. The line goes in the
  guide it belongs to (`docs/install.md`, `docs/operator.md`, `docs/security.md`) or in the commented
  `apps/board/.env.example` and `deploy/helm/rosterdock/values.yaml`.
- Scope client-specific policies per project, never board-wide.
- Working notes stay out of the tree: per-chat logs and the handoffs between chats live in `.notes/`
  (gitignored), and `.notes/README.md`, where it exists, has the local working rules.

## Names

Product: RosterDock. Package scope `@rosterdock/*`. Chart `rosterdock`. Images `rosterdock-board`,
`rosterdock-web`, `rosterdock-worker`. Settings `ROSTERDOCK_*`. The GitHub repository is
`DawBatteriesNotIncluded/RosterDock`. Until 2026-10-15 the product was Pharo (settings `PHAROS_*`); nothing
reads the old names. Teammate names (Peter, Cody, Verifier, Ricky, Brody, Archy, Reporter, Finn) are the
built-in personas' names and stay.
