# Backlog

Things noticed while building that are outside the current milestone. Move a line into the plan when it is
scheduled; delete it when it ships.

- CI builds the images for amd64 only, so a break that only arm64 shows first appears in a release's dry run.
  Build the three on `ubuntu-24.04-arm` in CI too, unpushed, with a cache scope per image and architecture
  that the release's arm64 builds can read.
- ci.yml's test, images and helm jobs have no `timeout-minutes`, and every release runs them first: a hang
  there holds a release for six hours. Give each one.
- OpenCode, the plan's third engine, has a row in `engines` (disabled) and no worker adapter. The hire form and
  the teammate editor do not offer it, and the built-in 'Cody 3' template moved to Claude Code. Shipping it
  means an adapter in `apps/worker/src/engines/` tested against recorded OpenCode output, and enabling the row.
- A run's claim reads object-store text (a review's diff, and the outputs of the tasks it depends on) inside the
  claim's transaction; with a bucket that answers slowly the transaction waits on the network. Read first, then
  claim, if it ever shows.
- A stdio connection's server runs inside the board pod as the board, so it can read the board's environment,
  a file secret store and the service account token (`docs/security.md`, What they can reach). Run those
  servers as another user, or in a sidecar, without any of them.
- The worker fleet is shared by every company on a board, and code a company controls (the repository's
  `test` script, an engine's shell) can read the worker's environment, the board's `DATABASE_URL` included
  (`docs/security.md`, Companies on one board). Give the worker a database role of its own that reaches
  only the pg-boss schema (`pgboss`); run the tests as another user, so `/proc` does not show them the
  worker's environment; give every run a fresh HOME and TMPDIR; and kill the engine's process group when it
  ends, as the test step's is, so nothing a run starts outlives it.
- With `worker.podMetrics.enabled` or `board.oauth.enabled`, the network policies open ports 443 and 6443 to
  any address, for the API server, in every worker pool too. Take the API server's address instead (the
  `kubernetes` Service's endpoints, or a value the operator sets).
- A teammate token an owner or admin mints lasts up to 30 days and no route revokes it. Add a list and a
  revoke in Settings, as events.
- Costs' "If billed the other way" shows US$0.00 for a teammate on a seat with no price set; say the seat is
  unpriced instead.
- Lint is not type-aware (`recommendedTypeChecked` is off, for speed), and `deploy/**` is ignored, so
  `deploy/scripts/*.mjs` is never linted. Turn the first on per package and lint the scripts.
- A rework run starts from the round sent back only on a repository (`apps/worker/src/rework.ts`). Without
  one it starts empty, though the round's documents are new-file diffs in its `changes.diff`; and a round with
  a binary file never carries over, since the diff has no bytes for it (the run's artifacts do).
- An MCP connection's authorization server metadata is used when the document's own `issuer` differs from
  the issuer the board asked (`discoverAuthorizationServer` in `apps/board/src/mcp/oauth.ts` keeps the one
  asked); RFC 8414 §3.3 says not to use it. Refuse a mismatch, once it is known which servers in use publish
  one (an OpenID document read for an issuer with a path is the usual case).
- A connection's OAuth client id, and its secret's name, change only through the API (`PATCH
/api/companies/:companyId/connections/:connectionId` with `oauth`): the card has no field for them. When an
  MCP server moves to another authorization server, a connection with a client id a person gave is removed
  and added again, losing the tool classifications and switches a person set. Add the fields to the card.
- An MCP answer at its 8 MB cap nested about four million levels deep raises the board's memory by about
  600 MB while the MCP SDK parses and checks it, before the board's own depth cut applies. Count the nesting
  in the answer's stream (`egressFetch`) and refuse past a few thousand levels before the SDK reads it.
- The scrub builds its automaton for every MCP and OpenAPI call (`apps/board/src/mcp/scrub.ts`): 50
  credentials of 8 KB take about 20 ms and 8 MB while the call lasts, and up to about 40 ms and 12 MB when
  they hold escapes JSON reads into further forms (capped at the credentials' length again). If that ever matters under concurrency,
  keep one per connection's credentials in an LRU bounded by bytes (credential length and arrays together),
  keyed by a hash over length-prefixed credentials, never the values.
- Company model providers (`docs/plan.html`, Company model providers), after its slices:
  - "Try a model" on a provider, a helper that moves teammates from one provider to another, and providers in
    template files.
  - Gateway metrics, and a run token bound to the pod that claimed its run. Fastify trusts the proxy, so the
    binding must read the socket's address, never `req.ip`; a service mesh that adds `X-Forwarded-For` inside
    the cluster would trip the gateway's refusal of that header.
  - Bedrock through AssumeRole, with an external id the board generates, after access keys.
  - The next kinds, in this order: Claude on Microsoft Foundry, Vertex, then Bedrock's Mantle endpoint (bare
    `openai.*` ids). Entra ID for Azure OpenAI.
  - A base-URL override for the Anthropic kind.
  - A budget that stops a run mid-way at the gateway, and budgets per provider.
  - The board's own model keys behind the gateway too, so no worker pod holds a model key.
  - The endpoint seal: an HMAC, with a key only the board holds, over a provider's or a connection's company,
    kind, endpoint, region and credential names, checked at every use, so a write to the database cannot
    repoint where a key is sent. It belongs with the worker's own database role (the fleet line above).
  - Codex on the worker past 0.144.5 (0.157.1 adds `amazon-bedrock-runtime`), in a pull request that records
    the worker's fixtures again.
