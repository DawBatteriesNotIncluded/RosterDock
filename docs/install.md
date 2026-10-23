# Installing RosterDock

A fresh cluster to a working board in an afternoon, ending with a first demo running on it. The operator guide
(`docs/operator.md`) covers the day after; the security notes (`docs/security.md`) say what the platform
guarantees and what it needs from you.

## What you need

| Thing              | Why                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Kubernetes >= 1.27 | Any distribution. The smoke script runs on kind, k3d, minikube or Docker Desktop.           |
| Postgres 16        | The board's only state store. Managed (RDS, Cloud SQL) or in-cluster; you own it.           |
| An S3 bucket       | Artifacts over 512 KB (up to 8 MB). MinIO works. Optional (see storage below).              |
| A secret store     | The chart reads every credential from a Kubernetes Secret you create; External Secrets fit. |
| helm 3.8+, kubectl | On the machine you install from (3.8 is the first helm that installs charts from OCI).      |
| Images             | Public on GHCR for every release, pulled by the chart (below), or built from a checkout.    |

Optional: KEDA (workers scale on queue depth), an ingress controller and cert-manager (TLS), an OIDC
provider (sign-in; without it only the local dev login exists, which is never for production), an OTLP
collector and Prometheus (observability).

## Ten minutes on a laptop first

`deploy/scripts/smoke.sh` builds the three images, runs a single-pod Postgres and MinIO in a throwaway
namespace on your current kubectl context, installs the chart against them with network policies on, and
curls the board through a port-forward. With Docker Desktop's Kubernetes or an existing kind cluster:

```bash
deploy/scripts/smoke.sh
```

With `KIND=1` it creates a kind cluster named `rosterdock-smoke` and loads the images into it first (CI runs
it that way on every push to `main`, the `smoke` job in `.github/workflows/ci.yml`). `KEEP=0`
tears everything down at the end. On Windows run it from Git Bash with `HELM` pointing at `helm.exe`.

## Keeping one on a laptop

`deploy/scripts/local-cluster.sh` is the smoke install made to stay: a kind cluster named `rosterdock`, the
images built here (the board with the model CLIs, `WITH_MODEL_CLIS=1`), Postgres on a volume, and the chart
installed with `deploy/helm/rosterdock/examples/local.yaml` (dev login, company secrets in the cluster's
Secrets, two workers, a volume for stdio connections). Teammates and Peter reach Claude with a subscription
token you make with `claude setup-token` and put in `rosterdock-engines` yourself; until it is there the
script leaves the workers at zero and says how. `IMPORT_LOCAL=1` first copies the dev database (`pnpm db:up`)
in, once, while the cluster's is empty. Run it again after a change: it rebuilds and rolls every pod. Your
current kubectl context is left as it was.

```bash
deploy/scripts/local-cluster.sh
kubectl --context kind-rosterdock -n rosterdock port-forward svc/rosterdock-web 8080:80
```

A worker on a Windows machine runs best where it runs in production, in Linux: under Docker Desktop (the
cluster above, or `docker compose --profile worker up -d worker`) or in WSL2. `pnpm dev:worker` also runs
natively on Windows with Git for Windows on PATH (CI runs the worker's tests there), but then a run's engine,
its shell and the repository's tests run as your Windows user, outside any container: keep that to
repositories you would run yourself (`docs/security.md`, Workers run model output).

## A URL your other devices can open

The compose stack on `localhost:8080` is enough to see everything, but some OAuth providers refuse a
`localhost` redirect URI, and a phone cannot open your laptop's localhost: compose publishes every port on
127.0.0.1 only, because the stack runs with the dev login on. `deploy/scripts/serve.sh`
puts the stack behind Tailscale Serve: `https://<machine>.<tailnet>.ts.net` with a real certificate,
reachable only from devices signed into your tailnet, never from the internet. It writes
`ROSTERDOCK_PUBLIC_URL` to `.env`; `docker-compose.public.yml` hands that to the board as its origin (the
OAuth redirect URIs, CORS and the session cookie), because the web container's nginx reports plain http.

```bash
deploy/scripts/serve.sh
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
```

OAuth callbacks work through it because the provider only redirects your browser, which is on the
tailnet. The dev login stays on and is safe there: the tailnet is the gate. On any origin the internet
can reach, turn it off and configure OIDC first (below). `deploy/scripts/serve.sh off` stops serving.

## Where the images and the chart come from

Every release is one version, cut from a `v` tag by `.github/workflows/release.yml`; `CHANGELOG.md` says
what each one changed.

| What   | Where                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Images | `ghcr.io/dawbatteriesnotincluded/rosterdock-board`, `rosterdock-web`, `rosterdock-worker`: public, linux/amd64 and linux/arm64 |
| Tags   | the version (`0.1.0`), and for a release that is not a prerelease its `MAJOR.MINOR` (`0.1`) and `latest`                       |
| Chart  | `oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock`, at the same version; no `helm repo add`, the reference is the chart |

The chart's version is its images' tag (its appVersion), so `--version` pins all of it: an install stays on
its version until you name another. `image.tag` runs other images under the same chart (a version, never
`latest`); `image.registry` takes all three from a registry of your own, a mirror or images you built; and
`worker.image` the workers alone (Engines on the worker, below). To read the values or start from the
examples without a checkout:

```bash
helm show values oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock --version 0.1.0
helm pull oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock --version 0.1.0 --untar   # ./rosterdock, with examples/
```

From a checkout the chart is `deploy/helm/rosterdock` (its `Chart.yaml` names the version whose images it
installs), and `docker build -f apps/<board|web|worker>/Dockerfile .` builds an image from the repo root.

## The real install

### 1. Secrets

Create these in the release namespace. The names are the ones `examples/production.yaml` uses; rename
freely, the values file points at them. Kubernetes starts no pod whose Secret is missing, so create every
Secret your values file names, or delete the lines of the optional ones you skip. Every value stays in your
secret store; the chart only ever holds the name and the key.

| Secret                   | Keys                                                                                                         | Who reads it                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rosterdock-db`          | `DATABASE_URL` (a full Postgres connection string)                                                           | board, worker (the queue lives in Postgres)                                                                                                            |
| `rosterdock-worker`      | `ROSTERDOCK_WORKER_TOKEN` (any long random string)                                                           | board and worker; the fleet's claim token                                                                                                              |
| `rosterdock-engines`     | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (Claude Code teammates), `OPENAI_API_KEY` (Codex teammates) | worker, handed to the engine process only (`worker.engineEnvNames`); also the board, when Peter plans through the model CLIs (`board.plannerEnvNames`) |
| `rosterdock-model`       | `ANTHROPIC_API_KEY`                                                                                          | board; Peter plans with it. Optional                                                                                                                   |
| `rosterdock-oidc`        | `ROSTERDOCK_OIDC_CLIENT_SECRET`                                                                              | board; sign-in through your identity provider (below)                                                                                                  |
| `rosterdock-storage`     | `S3_ACCESS_KEY`, `S3_SECRET_KEY`                                                                             | board. Optional                                                                                                                                        |
| `rosterdock-connections` | one key per connection credential NAME (`HUBSPOT_MCP_TOKEN`…)                                                | board; a key reaches companies only when `board.sharedEnvNames` lists it. Optional                                                                     |
| `rosterdock-notify`      | `ROSTERDOCK_NOTIFY_WEBHOOK_URL`                                                                              | board; needs-you notifications. Optional                                                                                                               |
| `rosterdock-github`      | `ROSTERDOCK_GITHUB_TOKEN`                                                                                    | board; opens pull requests after a review. Optional                                                                                                    |
| `rosterdock-gitlab`      | `ROSTERDOCK_GITLAB_TOKEN`                                                                                    | board; opens merge requests on GitLab projects. Optional                                                                                               |

The example's ingress also names `rosterdock-tls`, the certificate: cert-manager makes it from the ingress
annotation, or create a TLS Secret of that name yourself.

```bash
kubectl create namespace rosterdock
kubectl -n rosterdock create secret generic rosterdock-db --from-literal=DATABASE_URL='postgres://user:pass@host:5432/rosterdock'
kubectl -n rosterdock create secret generic rosterdock-worker --from-literal=ROSTERDOCK_WORKER_TOKEN="$(openssl rand -base64 32)"
kubectl -n rosterdock create secret generic rosterdock-engines --from-literal=ANTHROPIC_API_KEY='...'
# The optional ones examples/production.yaml names: skip a line here and delete its lines in your values
kubectl -n rosterdock create secret generic rosterdock-model --from-literal=ANTHROPIC_API_KEY='...'
kubectl -n rosterdock create secret generic rosterdock-oidc --from-literal=ROSTERDOCK_OIDC_CLIENT_SECRET='...'
kubectl -n rosterdock create secret generic rosterdock-storage --from-literal=S3_ACCESS_KEY='...' --from-literal=S3_SECRET_KEY='...'
kubectl -n rosterdock create secret generic rosterdock-connections --from-literal=HUBSPOT_MCP_TOKEN='...'
kubectl -n rosterdock create secret generic rosterdock-notify --from-literal=ROSTERDOCK_NOTIFY_WEBHOOK_URL='https://hooks.slack.com/services/...'
kubectl -n rosterdock create secret generic rosterdock-github --from-literal=ROSTERDOCK_GITHUB_TOKEN='...'
```

### 2. Values

Copy `examples/production.yaml` (in the chart pulled above, or `deploy/helm/rosterdock/examples/` in a
checkout) and edit: the ingress host and TLS, the Postgres CIDR and port (for the network policies), storage,
and which optional secrets exist. Everything in `values.yaml` is commented. The settings that matter:

| Value                            | Meaning                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `board.devLogin`                 | `false` in production. On, anyone reaching the board signs in with any email.                         |
| `board.autoscaling`              | An HPA on CPU. Boards are interchangeable: sessions and the event stream are in Postgres.             |
| `board.podDisruptionBudget`      | Keep one board up through node drains, when there is more than one board.                             |
| `board.oauth.enabled`            | Connections may authorise by OAuth; the board keeps the tokens in Secrets of its own (a Role).        |
| `board.sharedEnvNames`           | Keys of `rosterdock-connections` every company may name; no other key reaches a company. Empty: none. |
| `board.stdioCommands`            | Command lines a stdio connection may run inside the board, exactly (a final `*`: more arguments).     |
| `board.privateDestinations`      | Private names, addresses and ranges companies' connections may reach. Empty: public addresses only.   |
| `board.companyCreators`          | Who may create a company: emails, `@domain`s or `*`. Empty: the first company only.                   |
| `worker.autoscaling`             | A KEDA ScaledObject: one worker per waiting run between the bounds. Needs KEDA installed.             |
| `worker.image`                   | The worker image with Claude Code that you build (Engines on the worker, below). Empty: the chart's.  |
| `worker.engineEnvNames`          | Env var NAMES the worker hands to the engine, read from `worker.engineSecret`.                        |
| `worker.gitSecret`               | A token for cloning private repositories, by name, and `hosts`, the git hosts it is sent to.          |
| `worker.podMetrics.enabled`      | Pod CPU and memory from the metrics API (a worker account, a Role, the token) instead of the cgroup.  |
| `postgres.cidr`, `postgres.port` | Where Postgres answers; the network policies let the board and workers reach only that.               |
| `storage.*`                      | Endpoint, bucket, region, path style; credentials from `storage.externalSecret`.                      |
| `networkPolicy.enabled`          | On in production. See below.                                                                          |
| `networkPolicy.webIngressFrom`   | Who may reach the web (your ingress controller's namespace).                                          |
| `networkPolicy.worker.egressTo`  | Where workers may go besides the board and Postgres. Default: public HTTPS, nothing private.          |
| `*.resources`                    | Requests and limits for each component; every pod has both.                                           |

### 3. Install

```bash
helm upgrade --install rosterdock oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock --version 0.1.0 \
  -n rosterdock -f my-values.yaml --wait
```

Migrations run when the board starts, serialised across replicas. `helm status rosterdock -n rosterdock`
prints the URL or the port-forward to use. The first person to create a company on the empty board owns it,
and Peter is seated with it; after that, only the people `board.companyCreators` lists create companies, and
everyone else joins one when an owner invites their email.

### 4. Check

```bash
kubectl -n rosterdock get pods                      # board, web, worker Running
kubectl -n rosterdock logs deploy/rosterdock-board       # "migrations applied", then request logs
curl -s https://rosterdock.example.com/api/ready    # {"ok":true}
```

## Engines on the worker

A teammate's engine runs in the worker pod. The published worker image carries two of the three:

| Engine      | In the published image | Its credential, by name in `rosterdock-engines`  |
| ----------- | ---------------------- | ------------------------------------------------ |
| Stub        | yes                    | none: no model, no cost                          |
| Codex       | yes, pinned            | `OPENAI_API_KEY` or `CODEX_API_KEY`              |
| Claude Code | no                     | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |

The worker hands an engine only the names in `worker.engineEnvNames`, read from `rosterdock-engines`, and the
chart's default is `[ANTHROPIC_API_KEY]`: for Codex teammates on the published image, list `OPENAI_API_KEY`.

Claude Code is left out because its licence (Anthropic's Commercial Terms) does not allow a public image to
pass it on. Add it in an image of your own, kept in your own registry, at the version the release was
tested with, which the published image names in `ROSTERDOCK_CLAUDE_CODE_VERSION`:

```bash
docker build -t registry.example.com/rosterdock-worker:0.1.0-claude-code - <<'EOF'
FROM ghcr.io/dawbatteriesnotincluded/rosterdock-worker:0.1.0
USER root
RUN npm install -g "@anthropic-ai/claude-code@${ROSTERDOCK_CLAUDE_CODE_VERSION}" && npm cache clean --force
USER node
EOF
docker push registry.example.com/rosterdock-worker:0.1.0-claude-code
```

Then point the workers at it (a private registry also needs `imagePullSecrets`); every pool without an
`image:` of its own runs it too:

```yaml
worker:
  image: registry.example.com/rosterdock-worker:0.1.0-claude-code
  engineEnvNames: [ANTHROPIC_API_KEY]
```

Build it again from the new version's image on every upgrade, so the workers stay on the board's version.
From a checkout, `docker build --build-arg WITH_CLAUDE_CODE=1 -f apps/worker/Dockerfile .` builds the same
from source (docker compose and `deploy/scripts/local-cluster.sh` build the worker that way). A run on
Claude Code that reaches a worker without it fails at once: "Claude Code is not installed on this worker".

The published board image carries no model CLI either. Peter plans with the key in `board.modelSecret`, or
by role without one; planning through the Claude Code or Codex CLI (`board.plannerEnvNames`) takes a board
built from a checkout with `--build-arg WITH_MODEL_CLIS=1`, as `deploy/scripts/local-cluster.sh` builds it.

## Sign-in

Production signs in through your identity provider over OpenID Connect. Register a confidential client
(authorization code with PKCE; the token endpoint accepts `client_secret_basic`, or set `tokenAuth: post`)
with the redirect URI `https://<your host>/api/auth/oidc/callback`, put the client secret in a Secret, and
set:

```yaml
board:
  oidc:
    issuer: https://accounts.google.com # or https://login.microsoftonline.com/<tenant>/v2.0, your Keycloak realm, Okta...
    clientId: ...
    name: Google # the button
    allowedDomains: example.com # required at a public provider like Google; "*" lets every account in
    secret:
      name: rosterdock-oidc # ROSTERDOCK_OIDC_CLIENT_SECRET
```

The board discovers the endpoints from the issuer, verifies every id_token against the provider's keys
(signature, issuer, audience, expiry, nonce), and keeps only the subject, email and name. Memberships
come from the email claim: an owner grants a role by email in Settings, and the person who signs in with
that email through the provider is that user. At a public provider (Google, Microsoft's `common`, `consumers`
and `organizations` endpoints, GitLab.com, Apple) anyone holds an account, so the board will not start, and
the chart will not render, without `allowedDomains`: list yours, or `"*"` to let every account in on purpose.
Who may create a company is `board.companyCreators` (emails and `@domain`s, or `"*"`); without it the first
person to create one on the empty board owns it and nobody creates another. With an open provider, set it
before the board is reachable.
Sign out ends the board session and, when the provider's discovery document has an
`end_session_endpoint`, sends the browser there too (with the client id and `https://<your host>/` as
the way back), so a shared machine is signed out of the provider as well.
`board.devLogin` stays off: with it on, anyone reaching the board signs in as anyone.

`ROSTERDOCK_PUBLIC_URL` is set from `ingress.host` (or `board.publicUrl`) so the redirect goes where people
are; without an ingress the board takes it from the request behind your proxy.

## Network policies

With `networkPolicy.enabled`, three policies land:

- **web**: ingress from `networkPolicy.webIngressFrom` on 8080; egress to the board and DNS only.
- **board**: ingress from the web, the workers and `networkPolicy.boardIngressFrom`; egress to DNS, Postgres,
  storage, and `networkPolicy.board.egressPorts` towards `networkPolicy.board.egressTo` (default: anywhere on
  443 and 80, since the model API, git host, MCP servers and webhooks all live outside).
- **worker**: no ingress but its metrics port (from `networkPolicy.worker.metricsFrom`); egress to DNS, the
  board, Postgres, and `networkPolicy.worker.egressPorts` towards `networkPolicy.worker.egressTo`. The default
  is public HTTPS with every private range excluded: a worker running model output can reach the model API
  and the git host and nothing else in your cluster or VPC.

Narrow `networkPolicy.worker.egressTo` to your provider's published ranges when you know them. For a department that
must reach less, declare a pool:

```yaml
worker:
  pools: # each may also set image: for a fleet on its own worker build
    - name: secure # the department's sandbox says pool: secure
      egressTo: [] # the board and Postgres, nothing else
      egressPorts: []
```

Each pool is its own worker Deployment (and KEDA ScaledObject) consuming its own queue, with its own
NetworkPolicy. Set the pool on the department when you create it ("Runs on"), or by PATCH on its sandbox. Worker pods also mount no
service account token, run as non-root with a read-only root filesystem, and work on an ephemeral volume
that dies with the pod.

## Observability

- **Metrics.** The board serves Prometheus metrics at `/metrics` on its own port; the pod carries the
  `prometheus.io/scrape` annotations, and `observability.serviceMonitor.enabled` renders a ServiceMonitor
  for the Prometheus Operator. The web never proxies `/metrics`, so it stays inside the cluster; where the
  board's port is reachable anyway, set `board.metricsSecret` (a bearer token by Secret name) and scrapers
  must present it (the ServiceMonitor does). Counters
  for requests, events, finished runs, tokens, tool calls and approvals; gauges for runs live, approvals
  pending and tasks by status.
- **Traces.** One OpenTelemetry trace per run. Set `observability.otlp.endpoint` to your OTLP/HTTP
  collector (the `/v1/traces` path is added) and, when it needs a token, put `OTEL_EXPORTER_OTLP_HEADERS`
  (`k=v,k2=v2`) in a Secret named by `observability.otlp.headersSecret`. The board posts the run span with
  its steps and tool calls when the run ends; the worker posts what happened inside the pod under the
  same trace. A collector that is down loses spans, never runs.
- **Logs.** Both the board and the worker write one JSON object per line. The board redacts the headers
  that carry credentials and takes its request id from `x-request-id`; nothing on either side logs a
  secret value.
- **Pod resources.** Each running teammate's CPU and memory (from the worker pod's cgroup) show in the
  live process panel on the Company page. For a runtime whose engine forks beyond the cgroup,
  `worker.podMetrics.enabled` has the worker ask the metrics API instead (metrics-server must be
  installed): the worker gets an account of its own with a Role for pod metrics and its token mounted.

## Storage

The board keeps artifacts up to 512 KB inline in Postgres. Larger ones, up to 8 MB, go to the S3-compatible
bucket in `storage.*` (endpoint, bucket, region, path style; the key pair by Secret name), under
`companies/<id>/runs/<id>/<sha256>`; the board signs each request itself (Signature Version 4). Without a
bucket the board refuses an artifact over 512 KB, and the worker keeps its diff within the limit in whole
files: a file that does not fit is left out of the review and named in the run's summary. Make the bucket in
advance on AWS (the board creates a missing bucket only where the key may, as on MinIO), give the key pair
that bucket alone, and add a lifecycle rule if you delete companies: rows cascade, objects stay.

## A first demo on your cluster

Without a model key the stub engine does the work (no tokens, no cost), which is enough to
see Peter plan, a worker run, a review open and the numbers land.

1. Open the URL from `helm status` and sign in (through your provider, or the dev login on a laptop
   install).
2. **Create your first company.** Peter is seated with it.
3. **Teammates, Hire from template**: Ricky (researcher), Brody (requirements) and a third teammate named
   Stubby with the role "n8n engineer". Pick the engine **Stub (no model)** for all three unless the
   worker has a model key. Or **Settings, Templates, Import a file** with
   `deploy/templates/gtm-company.json` for the whole GTM company (those teammates run on Claude Code and
   need `rosterdock-engines`).
4. **Company page, New goal**: "Send a weekly digest of Gong calls with next steps to #sales every
   Friday." Peter plans before the modal returns: research, requirements and build, by role. The feed
   says "Peter split … into 3 tasks"; the research task starts on its own.
5. Watch the live rail: Ricky on #1, the step, the elapsed time, and the pod's CPU and memory. Within a
   minute the run completes, the task moves to Review, and Reviews has round 1 with its checks.
6. **Costs**: the run's tokens by teammate and model, the Monthly report with the chargeback table, the
   CSVs. **Activity**: every step as a sentence. `/metrics` on the board counts the run; your collector
   has its trace.

Done when you saw all of it from these pages alone.

## Upgrading

Read the new version's entry in `CHANGELOG.md`, back up Postgres, then name the version:

```bash
helm upgrade rosterdock oci://ghcr.io/dawbatteriesnotincluded/charts/rosterdock --version 0.2.0 \
  -n rosterdock -f my-values.yaml --wait
```

Migrations are forward-only and run on boot. A worker image you built with Claude Code is built again
from the new version's image, and `worker.image` moved to it in the same upgrade. `docs/operator.md` has
the rest.
