# Contributing to RosterDock

Thanks for taking the time. RosterDock is alpha, so the most useful contributions right now are bug reports
with a way to reproduce them, fixes, tests and documentation. For anything bigger than a fix, open an issue
first and say what you have in mind: the plan ([`docs/plan.html`](docs/plan.html)) and the backlog
([`docs/backlog.md`](docs/backlog.md)) say where the project is going, and a change outside them is easier to
agree on before it is written.

A security problem never goes in an issue or a pull request: see [`SECURITY.md`](SECURITY.md). Everyone taking
part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 22.12 or later, pnpm 10 (`npm install -g pnpm@10`, or `corepack enable` on Node 22 or 24,
which picks the pinned version) and Docker. Node 25 and later no longer ship corepack.

```bash
pnpm install
cp apps/board/.env.example apps/board/.env
cp apps/worker/.env.example apps/worker/.env
pnpm db:up          # Postgres, and MinIO for artifacts over 512 KB
pnpm db:migrate
pnpm dev            # the board on :3000, the web on http://localhost:5173
pnpm dev:worker     # a worker, in a second terminal
```

The README's quick start takes it from there with the stub engine, which needs no model and costs nothing.
The web's dev server sends `/api` to the board at `http://127.0.0.1:3000`; `ROSTERDOCK_BOARD_URL` points it at
another.

## Tests

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

`pnpm test` runs offline, but the board's tests need Postgres: each test file creates a throwaway database, so
start it with `docker compose up -d postgres` first. If your Postgres is elsewhere, point
`ROSTERDOCK_TEST_ADMIN_URL` at a role that may `CREATE DATABASE`. `pnpm format` fixes what `format:check`
finds. CI runs the same commands, then builds the web app and the images. On Windows, with Node 22.16 and the
newest 22, it runs the worker's and the shared package's tests and the board's `test/peter-cli-bin.test.ts`. There the worker's tests need Git for Windows on PATH, and the ones that make
symbolic links run only with Developer Mode on or as an administrator: without, they are skipped and say
why. In WSL2 or a Linux container they all run, as on Linux.

No test needs a model, a git host or an MCP server. Code that talks to one is tested against recorded
fixtures, never hand-written echoes, with `fetch` injected or mocked. The scripts under `apps/*/scripts`
re-record the fixtures; read a new recording for secrets, personal data and local paths before you commit it.

## A change that lands

- **Small and green.** One reviewable change per pull request, and every commit passes the four commands
  above.
- **Documented in the same change.** A new route, setting or concept lands with its doc line, or it does not
  land: in the guide it belongs to ([`docs/install.md`](docs/install.md),
  [`docs/operator.md`](docs/operator.md), [`docs/security.md`](docs/security.md)), or in the commented
  [`apps/board/.env.example`](apps/board/.env.example) and
  [`deploy/helm/rosterdock/values.yaml`](deploy/helm/rosterdock/values.yaml).
- **Inside the rules that never soften.** Secrets are env var names or secret references, never values in
  Postgres, events, logs or responses (`assertNoRawSecrets` from `@rosterdock/shared` guards every write
  boundary). Every mutating route declares its `config.action` for the role guard and appends an event in
  the same transaction (`mutate`). Teammates never mark a task Done; an approved review does. A write to a
  live system is proposed, approved and then executed, bound to the exact payload by its sha256. Policy only
  narrows. Everything is per company.
- **Manager language in the UI**: names, tasks, conversations, reviews, approvals. No lanes, leases, run specs
  or blocker codes on screen. The design tokens in `apps/web/src/styles/tokens.css` match
  [`docs/prototype.html`](docs/prototype.html), and both themes must work.

[`CLAUDE.md`](CLAUDE.md) holds the same layout, commands and rules in the form coding agents read; keep the two
in step when you change one.

## Commits and pull requests

Write the subject as the area and what changed (`Board: a goal's caps can change after it starts`), and the
body as why. The pull request template has the checklist a reviewer will go through.

## Licence

RosterDock is licensed under the Apache License 2.0. Unless you say otherwise, what you contribute is licensed
under the same terms, as section 5 of the licence describes.
