# Security policy

## Reporting a vulnerability

Report a security problem privately through GitHub: on the repository's **Security** tab, choose **Report a
vulnerability**, or open
[the form](https://github.com/DawBatteriesNotIncluded/RosterDock/security/advisories/new) directly. Please do
not open a public issue, pull request or discussion about it.

Say what you found, how to reproduce it (the version or commit, and where it ran: local development, Docker
Compose or the Helm chart) and what someone could do with it. Leave real secrets and personal data out of the
report; describing their shape is enough.

The maintainers acknowledge the report in the advisory, work on the fix there with you, and publish the
advisory with the release that fixes it, crediting you unless you would rather not be named.

## Supported versions

RosterDock is alpha (0.x). Fixes land on `main` and in the next release; earlier releases are not patched.

## Scope

In scope: the board, the web app, the worker, the Helm chart and the scripts in this repository, measured
against what [`docs/security.md`](docs/security.md) says the platform guarantees. Out of scope: the local dev
login (`ROSTERDOCK_DEV_LOGIN=1`, which lets anyone sign in as anyone and is never for production), deployments
that turn off the protections that guide describes, and what a model chooses to do within the toolbox,
policies and approvals a person gave it.
