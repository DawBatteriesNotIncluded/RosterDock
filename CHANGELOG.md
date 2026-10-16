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
- Costs, budgets and drift alerts per company; Prometheus metrics, OpenTelemetry traces and JSON logs.
- Sign-in through OpenID Connect, and the roles owner, admin, reviewer, viewer and teammate.
- The Helm chart: board, web and worker against your Postgres and S3-compatible bucket, every credential by
  Secret name, network policies, KEDA scaling and worker pools.
- Published releases. A `v*` tag runs CI on the tagged commit, then pushes the three images for linux/amd64
  and linux/arm64 to GHCR, tagged with the version (and `MAJOR.MINOR` and `latest` unless a prerelease),
  and the chart to `oci://ghcr.io/dawbatteriesnotincluded/charts` at the same version, whose appVersion
  names those images (`.github/workflows/release.yml`). Run by hand, it is a dry run that pushes nothing.
- The web image carries the licence of every package bundled into the UI, each with its text, in
  `third-party-licenses.txt`, which it also serves at `/third-party-licenses.txt`.

### Changed

Against the images built from the tree before this release:

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

- Handing Peter a goal could fail with an internal error, and leave it half planned, when Peter's loop started
  the plan's first task while the rest were still being filed: filing a task and starting the task it waits on
  took their locks in opposite orders, and Postgres broke the deadlock by cancelling the filing.

### Security

- CI's token only reads the repository, every action is pinned to a commit with its tag beside it, and
  Dependabot proposes updates to the actions, the npm workspace and the images' base images a week after
  each is released (security updates at once).
