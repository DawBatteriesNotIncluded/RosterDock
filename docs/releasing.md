# Releasing RosterDock

For the maintainers. A release is one version for the three images and the chart, published by
`.github/workflows/release.yml` when a tag `v<version>` is pushed. Operators read `docs/install.md` and
`CHANGELOG.md`; this is the other side of them.

## Cutting one

1. On `main`, with CI green: move what changed under the new version's heading in `CHANGELOG.md`, dated
   (`## 0.2.0 (2026-11-02)`), and set `version` and `appVersion` in `deploy/helm/rosterdock/Chart.yaml` to it.
   The workflow publishes the tag's version whatever `Chart.yaml` says, and warns when the two differ;
   keeping them equal keeps a checkout's chart on its own images.
2. Commit, tag that commit, push the tag:

   ```bash
   git tag -a v0.2.0 -m "RosterDock 0.2.0"
   git push origin v0.2.0
   ```

3. The workflow runs CI on the tagged commit (the tests, the image builds, the smoke install on kind, helm
   lint). Then it builds each image for linux/amd64 and linux/arm64 and pushes it as `0.2.0`, `0.2` and
   `latest`, and last packages the chart as version `0.2.0` with appVersion `0.2.0` and pushes it to
   `oci://ghcr.io/dawbatteriesnotincluded/charts`. A prerelease (`v0.2.0-rc.1`) is pushed under its own
   version only, never `0.2` or `latest`.
4. Check what a stranger gets, signed out of GHCR:

   ```bash
   docker logout ghcr.io
   docker pull ghcr.io/dawbatteriesnotincluded/rosterdock-worker:0.2.0
   helm show chart oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock --version 0.2.0
   ```

A failed image or chart job can be re-run alone from the run's page; the jobs that passed are not built
again, and the chart waits for every image. If CI fails on the tag, nothing was pushed: delete the tag,
fix, and tag again. Once anything of a version is published, never move or reuse its tag: fix forward with
the next patch version.

**A dry run.** Actions, release, Run workflow, with any version: CI and every build run for both
architectures, and nothing logs in or pushes.

**What the images leave out.** The board is built with `WITH_MODEL_CLIS=0` and the worker with
`WITH_CLAUDE_CODE=0`: Claude Code's licence (Anthropic's Commercial Terms) does not allow a public image to
pass it on. Codex (Apache-2.0) ships in the worker. Both CLIs are pinned in the Dockerfiles to the versions
their parsers' fixtures were recorded with; moving one means recording the fixtures again first.

## Once, before the first release

- **Make the packages public.** GHCR creates each package private at its first push. After the first run,
  for each of `rosterdock-board`, `rosterdock-web`, `rosterdock-worker` and `charts/rosterdock` (your profile,
  Packages): Package settings, Change visibility, Public. It cannot be made private again.
- **A package that already exists** under one of those names (pushed by hand before) must give this
  repository write access in its settings (Manage Actions access) or the push is refused. Packages the
  workflow creates get it on their own.
- **Actions.** Settings, Actions, General: actions allowed to run, including `docker/*`, `azure/setup-helm`,
  `helm/kind-action` and `pnpm/action-setup` (CI uses them already). The default workflow permissions can
  stay read-only: each workflow asks for what it needs, and only the release's image and chart jobs may
  write packages. Every action is pinned to a commit, so "Require actions to be pinned to a full-length
  commit SHA" can be turned on.
- **Dependabot.** Version updates run from `.github/dependabot.yml`; turn on alerts and security updates in
  Settings, Code security.
- **Who may release.** Anyone who can push a `v*` tag publishes. A tag ruleset on `v*` (Settings, Rules)
  can keep creating release tags to the maintainers and forbid moving or deleting one.
