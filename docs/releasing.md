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
   smoke install on kind, helm lint). Then it builds each image twice, linux/amd64 on `ubuntu-latest` and
   linux/arm64 on `ubuntu-24.04-arm` (GitHub's arm64 runner, free for a public repository; nothing is
   emulated), each half with its provenance and SBOM and pushed by its digest alone. A merge per image checks
   that the two halves make one image with both architectures, their attestations and a description, then
   pushes it as `0.2.0`, `0.2` and `latest`. Last it packages the chart as version `0.2.0` with appVersion
   `0.2.0` and pushes it to `oci://ghcr.io/dawbatteriesnotincluded/charts`. A prerelease (`v0.2.0-rc.1`) is
   pushed under its own version only, never `0.2` or `latest`.
4. Check what a stranger gets, signed out of GHCR:

   ```bash
   docker logout ghcr.io
   docker pull ghcr.io/dawbatteriesnotincluded/rosterdock-worker:0.2.0
   helm show chart oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock --version 0.2.0
   ```

A failed build, merge or chart job is re-run from the run's page with Re-run failed jobs: only what failed
is built again, a merge finds the other half's digest in the run (kept 30 days, as long as a run can be
re-run), a merge run twice pushes the same image, and the chart waits for every image. An image that fails
leaves the others to merge and push whole; its own merge fails until both of its halves are built. Re-run
all jobs instead builds everything again and moves the version's tags to the new images. A build step
that hangs ends after 10 minutes. Re-run soon: each half takes its base images (`node:22-alpine`,
`nginx:1.30-alpine`) as they are when it builds, so a half re-run days later can sit on newer ones than the
half already pushed. And never re-run a release's run once a newer version is out: every merge also pushes
`MAJOR.MINOR` and `latest`, which would move back to the older images. Cut the next version instead. If
CI fails on the tag, nothing was pushed, but the tag stays:
the `release tags` ruleset forbids moving or deleting a `v*` tag. Fix on `main` and tag again under the next
version, so a failed `v0.2.0-rc.1` is followed by `v0.2.0-rc.2` and a failed `v0.2.0` by `v0.2.1`. That is
why a version starts with a dry run and a prerelease tag.

**A dry run.** Actions, release, Run workflow, with any version: CI (without the smoke install, which runs
on a tag) and all six builds run, every image on both architectures on its own runner, attestations
included, and the chart is packaged and linted; nothing logs in or pushes. The merges are skipped, with
nothing pushed to merge, so a change to the release's merge is first run by a tag: one more reason that tag
is a prerelease.

**Untagged versions on GHCR.** Each release leaves six untagged versions per image besides its tagged
index: for each architecture, its image, its attestation and the index the build pushed by digest. The
tagged index needs the images and attestations for good, and a merge re-run reads the per-architecture
indexes for as long as the run can be re-run (30 days). Prune none of them; after those 30 days only the
two per-architecture indexes may go.

**The arm64 runner** (`ubuntu-24.04-arm`) is free for a public repository. A private copy needs an arm64
runner of its own, or its arm64 builds wait in the queue until GitHub gives up on them.

**What the images leave out.** The board is built with `WITH_MODEL_CLIS=0` and the worker with
`WITH_CLAUDE_CODE=0`: Claude Code's licence (Anthropic's Commercial Terms) does not allow a public image to
pass it on. Codex (Apache-2.0) ships in the worker. Both CLIs are pinned in the Dockerfiles to the versions
their parsers' fixtures were recorded with; moving one means recording the fixtures again first.

## Once, before the first release

- **The packages' visibility.** The first release (`v0.1.0-rc.1`) created `rosterdock-board`,
  `rosterdock-web`, `rosterdock-worker` and `charts/rosterdock` public, as this public repository is: a
  signed-out pull works with nothing switched on. A package made public cannot be made private again. A
  private copy of the repository should check each package after its first release (your profile,
  Packages, Package settings, Change visibility).
- **A package that already exists** under one of those names (pushed by hand before) must give this
  repository write access in its settings (Manage Actions access) or the push is refused. Packages the
  workflow creates get it on their own.
- **Actions.** Settings, Actions, General: actions allowed to run, including `docker/*`, `azure/setup-helm`,
  `helm/kind-action` and `pnpm/action-setup` (CI uses them already). The default workflow permissions can
  stay read-only: each workflow asks for what it needs, and only the release's build, merge and chart jobs may
  write packages. "Require actions to be pinned to a full-length commit SHA" is on, so a new action is
  pinned to a commit or its workflow does not run.
- **Dependabot.** Version updates run from `.github/dependabot.yml`; alerts and security updates are on in
  Settings, Code security.
- **Code security.** Private vulnerability reporting is on: `SECURITY.md` and the issue template send
  reporters to `/security/advisories/new`. Secret scanning and push protection are on, and skip only the
  files `.github/secret_scanning.yml` names. CodeQL runs in its default setup.
- **Rules.** The `main` ruleset takes changes only through a squash-merged pull request whose required CI
  checks are green (typecheck, lint, test; build images; helm lint; smoke install on kind, where skipped
  counts), with no force-push, no deletion and nobody exempt. CI also runs worker tests on Windows (node
  22.16) and (node 22), on every pull request and on a tag, where a failure stops the release: add both to the
  required checks, or a pull request that breaks them merges green and the next tag spends its version. They
  are named by the matrix's Node versions, so a change to the matrix changes the ruleset with it, or every
  pull request waits on a check that never runs. The `release tags` ruleset forbids moving or deleting a `v*`
  tag. Anyone who can push a `v*` tag publishes.
- **The pre-release sentences.** When 0.1.0 ships, delete the sentence in `README.md`'s Status that says
  nothing is published, and the two sentences directly under "Where the images and the chart come from" in
  `docs/install.md`.
