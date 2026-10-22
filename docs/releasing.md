# Releasing RosterDock

For the maintainers. A release is one version for the three images and the chart, published by
`.github/workflows/release.yml` when a tag `v<version>` is pushed. Operators read `docs/install.md` and
`CHANGELOG.md`; this is the other side of them.

## Cutting one

1. In a pull request: move what changed under the new version's heading in `CHANGELOG.md`, dated
   (`## 0.2.0 (2026-11-02)`), and set `version` and `appVersion` in `deploy/helm/rosterdock/Chart.yaml` to it.
   The workflow publishes the tag's version whatever `Chart.yaml` says, and warns when the two differ;
   keeping them equal keeps a checkout's chart on its own images. Squash-merge it once CI is green: the
   `main` ruleset takes changes only that way.
2. Tag the merged commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag -a v0.2.0 -m "RosterDock 0.2.0"
   git push origin v0.2.0
   ```

3. The workflow runs CI on the tagged commit (the tests, the worker's tests on Windows, the image builds, the
   smoke install on kind, helm lint). Then it builds each image for linux/amd64 and linux/arm64 and pushes it
   as `0.2.0`, `0.2` and `latest`, and last packages the chart as version `0.2.0` with appVersion `0.2.0` and
   pushes it to `oci://ghcr.io/dawbatteriesnotincluded/charts`. A prerelease (`v0.2.0-rc.1`) is pushed under
   its own version only, never `0.2` or `latest`.
4. Check what a stranger gets, signed out of GHCR:

   ```bash
   docker logout ghcr.io
   docker pull ghcr.io/dawbatteriesnotincluded/rosterdock-worker:0.2.0
   helm show chart oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock --version 0.2.0
   ```

A failed image or chart job can be re-run alone from the run's page; the jobs that passed are not built
again, and the chart waits for every image. If CI fails on the tag, nothing was pushed, but the tag stays:
the `release tags` ruleset forbids moving or deleting a `v*` tag. Fix on `main` and tag again under the next
version, so a failed `v0.2.0-rc.1` is followed by `v0.2.0-rc.2` and a failed `v0.2.0` by `v0.2.1`. That is
why a version starts with a dry run and a prerelease tag.

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
  write packages. "Require actions to be pinned to a full-length commit SHA" is on, so a new action is
  pinned to a commit or its workflow does not run.
- **Dependabot.** Version updates run from `.github/dependabot.yml`; alerts and security updates are on in
  Settings, Code security.
- **Code security.** Private vulnerability reporting is on: `SECURITY.md` and the issue template send
  reporters to `/security/advisories/new`. Secret scanning and push protection are on, and skip only the
  files `.github/secret_scanning.yml` names. CodeQL runs in its default setup.
- **Rules.** The `main` ruleset takes changes only through a squash-merged pull request whose required CI
  checks are green: typecheck, lint, test; build images; helm lint; smoke install on kind (skipped counts);
  and worker tests on Windows (node 22.16) and (node 22). No force-push, no deletion, nobody exempt. The
  Windows checks are named by the matrix's Node versions: a change to the matrix changes the ruleset too, or
  every pull request waits on a check that never runs. The
  `release tags` ruleset forbids moving or deleting a `v*` tag. Anyone who can push a `v*` tag publishes.
- **The pre-release sentences.** When 0.1.0 ships, delete the sentence in `README.md`'s Status that says
  nothing is published, and the two sentences directly under "Where the images and the chart come from" in
  `docs/install.md`.
