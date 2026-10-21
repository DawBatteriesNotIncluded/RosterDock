# Backlog

Things noticed while building that are outside the current milestone. Move a line into the plan when it is
scheduled; delete it when it ships.

- OpenCode, the plan's third engine, has a row in `engines` (disabled) and no worker adapter. The hire form and
  the teammate editor do not offer it, and the built-in 'Cody 3' template moved to Claude Code. Shipping it
  means an adapter in `apps/worker/src/engines/` tested against recorded OpenCode output, and enabling the row.
- A run's claim reads object-store text (a review's diff, and the outputs of the tasks it depends on) inside the
  claim's transaction; with a bucket that answers slowly the transaction waits on the network. Read first, then
  claim, if it ever shows.
- A stdio connection's server runs inside the board pod as the board, so it can read the board's environment,
  a file secret store and the service account token (`docs/security.md`, What they can reach). Run those
  servers as another user, or in a sidecar, without any of them.
- An HTTP or OpenAPI connection, its OAuth discovery and a notification webhook reach any address the board pod
  can, cluster-internal ones included; only `networkPolicy.board.egressTo` narrows them. Refuse private and
  link-local addresses unless the operator lists them.
- The worker fleet is shared by every company on a board, and code a company controls (the repository's
  `test` script, an engine's shell) can read the worker's environment, the board's `DATABASE_URL` included
  (`docs/security.md`, Companies on one board). Give the worker a database role of its own that reaches
  only the pg-boss schema (`pgboss`); run the tests as another user, so `/proc` does not show them the
  worker's environment; give every run a fresh HOME and TMPDIR; and kill the engine's and the tests'
  process groups when they end, so nothing a run starts outlives it.
- With `worker.podMetrics.enabled` or `board.oauth.enabled`, the network policies open ports 443 and 6443 to
  any address, for the API server, in every worker pool too. Take the API server's address instead (the
  `kubernetes` Service's endpoints, or a value the operator sets).
- A teammate token an owner or admin mints lasts up to 30 days and no route revokes it. Add a list and a
  revoke in Settings, as events.
- A goal names a repository for the project it opens, but cannot go into a project that exists
  (`apps/board/src/peter/goals.ts`). Let a goal name an existing project.
- Costs' "If billed the other way" shows US$0.00 for a teammate on a seat with no price set; say the seat is
  unpriced instead.
- Lint is not type-aware (`recommendedTypeChecked` is off, for speed), and `deploy/**` is ignored, so
  `deploy/scripts/*.mjs` is never linted. Turn the first on per package and lint the scripts.
- A rework run starts from the round sent back only on a repository (`apps/worker/src/rework.ts`). Without
  one it starts empty, though the round's documents are new-file diffs in its `changes.diff`; and a round with
  a binary file never carries over, since the diff has no bytes for it (the run's artifacts do).
