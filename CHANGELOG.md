# Changelog

Every release of RosterDock, newest first. A release is one version shared by the three images
(`ghcr.io/dawbatteriesnotincluded/rosterdock-board`, `rosterdock-web`, `rosterdock-worker`) and the chart
(`oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock`). Versions follow
[Semantic Versioning](https://semver.org/): before 1.0 a minor version may break something, and its entry
says what. How to upgrade is in `docs/operator.md`; how a release is cut, in `docs/releasing.md`.

## 0.1.0 (unreleased)

The first published release: the plan's milestones M0 to M6 (`docs/plan.html`, `docs/m0.md` to
`docs/m6.md`) and the backlog worked after them.

### Added

- Departments of AI teammates, each a brain (Claude Code, Codex or the stub engine), a persona and a governed
  toolbox of MCP and OpenAPI connections.
- Peter, the project-manager teammate, who plans goals into tasks by role, watches them and re-plans; department
  leads plan inside their departments.
- A shared kanban, messages and an inbox between teammates, and hunk-level reviews with checks. An approved
  review, never a teammate, marks work done, and may open a pull request (GitHub) or a merge request (GitLab).
- Writes to live systems as propose, approve, execute, bound to the exact payload by its sha256.
- Connections to MCP servers over HTTP or stdio, and to OpenAPI services, with OAuth where the server offers
  it; each company keeps its own credentials as write-only secrets under Settings.
- Needs-you notifications to a webhook (Slack's works as is) or by email.
- Costs, budgets and drift alerts per company; Prometheus metrics, OpenTelemetry traces and JSON logs.
- Companies, departments and teammates exported and imported as files, and style packs: published rule
  files every teammate's brief carries, pinned by commit and sha256.
- Sign-in through OpenID Connect, and the roles owner, admin, reviewer, viewer and teammate.
- The Helm chart: board, web and worker against your Postgres and S3-compatible bucket, every credential by
  Secret name, network policies, KEDA scaling and worker pools.
- Published releases. A `v*` tag runs CI on the tagged commit, then pushes the three images for linux/amd64
  and linux/arm64 to GHCR, each architecture built on a runner of its own (no emulation) with its provenance
  and SBOM, tagged with the version (and `MAJOR.MINOR` and `latest` unless a prerelease), and the chart to
  `oci://ghcr.io/dawbatteriesnotincluded/charts` at the same version, whose appVersion names those images
  (`.github/workflows/release.yml`). Run by hand, it is a dry run that pushes nothing.
- The web image carries the licence of every package bundled into the UI, each with its text, in
  `third-party-licenses.txt`, which it also serves at `/third-party-licenses.txt`.
- Web access for teammates, through the board. The web connection (Settings > Connections > Web) reads public
  pages for the teammates granted it: every address a name resolves to is checked and the board connects to
  no other, a company's list of sites narrowed by a department and a client, every page an event. The
  catalog has search, browser and fetch servers a company may run instead (Brave Search, Tavily, Exa,
  Playwright, the MCP reference fetch server), and the brief tells each teammate which web tools it has.
- A worker that runs natively on Windows (`pnpm dev:worker` with Git for Windows), tested there in CI, with
  the worker's git and file rules kept by Windows' own means; Docker or WSL2 stays the place for
  repositories you would not run yourself (`docs/security.md`). A board there plans with Claude Code or Codex
  as npm installs them.

### Changed

Against the images built from the pre-release tree (then called Pharo, not public):

- A company reaches only its own secrets and the names the operator shares, and four things are closed by
  default: the board's environment (`board.sharedEnvNames` lists what companies may name), stdio commands
  (`board.stdioCommands`), who creates companies (`board.companyCreators`), and a public sign-in provider
  with no `board.oidc.allowedDomains`. `docs/operator.md` (Upgrades and backups) says what to set.
- The worker image leaves Claude Code out: its licence (Anthropic's Commercial Terms) does not allow a public
  image to pass it on. The chart's `worker.image` points the workers at one you build with it on top of the
  published image (`docs/install.md`, Engines on the worker), and a run on Claude Code that reaches a worker
  without it fails at once and says so.
- The model CLIs are pinned to the versions their parsers were recorded with, where they installed whatever
  was latest: Codex 0.144.5 in the worker and Claude Code 2.1.285 when you add it; Claude Code 2.1.285 and
  Codex 0.157.1 in a board built with `WITH_MODEL_CLIS=1`.
- The chart is installed from `oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock` with `--version`, and
  `examples/production.yaml` no longer pins `image.tag`: the chart's version picks the images.
- The built-in teammate templates, and the model a hire or Peter falls back on, are the current ones: Opus 5.5
  for Peter, Verifier, Archy and Finn, Sonnet 5.5 for the rest. Opus 5.5 also costs less than the Opus 5 they
  named. The demo templates' Haiku teammates run on Haiku 5.5, and Settings fills its list price. A teammate
  already hired keeps its model.
- The web image carries its fonts, Schibsted Grotesk and IBM Plex Mono (SIL Open Font License), where the
  page loaded them from Google Fonts: an install without internet access shows them, and no page load sends
  a visitor's address to Google.
- What a company chooses the board should reach (an MCP server or OpenAPI service, the OAuth endpoints its
  server names, the company's own webhook and SMTP server) must be at a public address, by the address
  ranges the web connection refuses, unless the operator lists it in `board.privateDestinations`
  (`ROSTERDOCK_PRIVATE_DESTINATIONS`; empty by default). A connection at a private address (loopback, the
  private ranges, link-local and cloud metadata) fails its check and its calls with "refused: … which this
  board's operator has not allowed" until it is listed. The check goes by address range: cluster addresses
  outside the private ranges, and public addresses that lead inside, pass it, so the network policy still
  matters (`docs/security.md`). An MCP server that redirects to another server, and an OpenAPI operation or a
  webhook that answers with any redirect, fails and names the server it pointed to. An MCP server's
  redirect within its own server is followed when the call arrives as sent (307, 308); a 301 or 302, as an
  http-to-https rule sends, would turn the call into a GET, so it fails and says what to change (over https,
  or with or without the trailing slash). An answer is read only up to its call site's cap,
  decoded. OAuth endpoints must be https (http only to a listed destination), and the resource an MCP server
  declares must be on its own origin, at or above its MCP URL's path; a connection that kept one that is not,
  or an issuer now refused or without metadata, is discovered again at its next Authorise, its old tokens
  dropped and nothing of one issuer sent to another (a person's client id is refused there). The board's own destinations (git hosts, OIDC, OTLP, the bucket, the
  API server, the model API, its webhook and SMTP server) are not checked. An entry may be one company's
  alone (`<company id>=<entry>`, or `{ company, destination }` in the chart), which no other company's
  connections reach, unless an entry for every company covers it too, and no other company sees (a stdio
  command is outside the check, as before). Settings shows owners and admins the entries that apply to their company, and flags a URL whose
  address the board refuses or whose name looks private and is not listed. `docs/operator.md` (Private
  destinations) says what to list.

### Renamed

The product is RosterDock; the tree before this release called it Pharo. Nothing reads the old names, so an
install built from that tree changes each of these:

- Settings: `PHAROS_*` is `ROSTERDOCK_*`, every one of them, in the board's and the worker's environment, the
  `.env` files and compose.
- Chart: `pharo` is `rosterdock`, at `deploy/helm/rosterdock` and
  `oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock`. Its selector labels change, so a release of the
  old chart is uninstalled and installed again, not upgraded. The example Secrets are `rosterdock-db`,
  `rosterdock-worker`, `rosterdock-engines` and so on, and the pool label is `rosterdock.dev/pool`.
- Images: `pharo-board`, `pharo-web` and `pharo-worker` are `rosterdock-board`, `rosterdock-web` and
  `rosterdock-worker`, in the same registry.
- Package scope: `@pharo/*` is `@rosterdock/*`.
- What the board keeps and sends under its name: the secret store's entries are `rosterdock-company-<id>` and
  `rosterdock-connection-<id>` (rename the old Secrets or files, or set the values again), the metrics
  `rosterdock_*` and the trace attributes `rosterdock.*` (dashboards and alerts), the session cookie
  `rosterdock_session` (everyone signs in again), the branch an approved review pushes `rosterdock/task-N`,
  and the templates file format `rosterdock/templates/1` (edit the `format` line of a file exported before).
- Docker compose: the project, the database with its role and password, the bucket and MinIO's root user are
  `rosterdock`, so the stack starts on new volumes; copy the old ones across or start empty.

### Fixed

- A process the repository's tests started (a server, a watcher) outlived the test step, and one that kept
  the output open after a passing script held the step to its time limit, which it then reported as a
  timeout. The script now leads a process group of its own (a job object on Windows), which the step ends
  past its time limit, on Stop and when the script ends.
- Handing Peter a goal could fail with an internal error, and leave it half planned, when Peter's loop started
  the plan's first task while the rest were still being filed: filing a task and starting the task it waits on
  took their locks in opposite orders, and Postgres broke the deadlock by cancelling the filing.

- A teammate hired from the built-in 'Cody 3' template, or put on OpenCode in its editor, failed every run:
  no worker runs OpenCode yet. The template runs on Claude Code, and the pickers no longer offer OpenCode.
- Activity and the Company page showed a teammate's logged decision by its raw event name, and a task a
  person marked blocked explained itself as waiting on a teammate's answer.

### Security

- CI's token only reads the repository, every action is pinned to a commit with its tag beside it, and
  Dependabot proposes updates to the actions, the npm workspace and the images' base images a week after
  each is released (security updates at once).
