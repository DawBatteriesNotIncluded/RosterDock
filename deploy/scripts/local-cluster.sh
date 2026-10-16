#!/usr/bin/env bash
# RosterDock on a local Kubernetes cluster for one person, kept between runs: a kind cluster, the images built
# here (the board with the model CLIs, the worker with Claude Code) and loaded into it, Postgres with a
# volume, and the chart installed with examples/local.yaml. Run it again after a change: it rebuilds and
# rolls every pod.
#
# Claude is reached with a subscription token you put in the rosterdock-engines secret yourself; until it is
# there the workers stay at zero and Peter plans by role, and the script says how. setup-token prints the
# token wrapped and indented, so the command strips whitespace from what you paste:
#   claude setup-token
#   read -rs TOKEN; TOKEN=$(printf %s "$TOKEN" | tr -d '[:space:]'); kubectl --context kind-rosterdock -n rosterdock \
#     create secret generic rosterdock-engines --from-literal=CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
#     --dry-run=client -o yaml | kubectl --context kind-rosterdock -n rosterdock apply -f -; unset TOKEN
#
#   deploy/scripts/local-cluster.sh
#   IMPORT_LOCAL=1 deploy/scripts/local-cluster.sh   # first copy the dev database (pnpm db:up) in, once
#
# Needs: docker, kind, kubectl, helm. Your current kubectl context is left as it was.
set -euo pipefail

CLUSTER="${CLUSTER:-rosterdock}"
NAMESPACE="${NAMESPACE:-rosterdock}"
RELEASE="${RELEASE:-rosterdock}"
TAG="${TAG:-local}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHART="$ROOT/deploy/helm/rosterdock"
CTX="kind-$CLUSTER"
K=(kubectl --context "$CTX" -n "$NAMESPACE")

say() { printf '\n== %s\n' "$*"; }

say "images rosterdock-board:$TAG (with the model CLIs), rosterdock-web:$TAG, rosterdock-worker:$TAG (with Claude Code)"
docker build -q -t "rosterdock-board:$TAG" --build-arg WITH_MODEL_CLIS=1 -f "$ROOT/apps/board/Dockerfile" "$ROOT"
docker build -q -t "rosterdock-web:$TAG" -f "$ROOT/apps/web/Dockerfile" "$ROOT"
docker build -q -t "rosterdock-worker:$TAG" --build-arg WITH_CLAUDE_CODE=1 -f "$ROOT/apps/worker/Dockerfile" "$ROOT"

say "kind cluster $CLUSTER"
if ! kind get clusters | grep -qx "$CLUSTER"; then
  previous="$(kubectl config current-context 2>/dev/null || true)"
  kind create cluster --name "$CLUSTER"
  # kind switches the current context to the new cluster; put yours back.
  if [ -n "$previous" ]; then kubectl config use-context "$previous" >/dev/null; fi
fi
kind load docker-image --name "$CLUSTER" "rosterdock-board:$TAG" "rosterdock-web:$TAG" "rosterdock-worker:$TAG"

say "namespace $NAMESPACE with Postgres on a volume"
kubectl --context "$CTX" create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -
"${K[@]}" apply -f - <<'EOF'
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels: { app: postgres }
  template:
    metadata:
      labels: { app: postgres }
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - { name: POSTGRES_USER, value: rosterdock }
            - { name: POSTGRES_PASSWORD, value: rosterdock }
            - { name: POSTGRES_DB, value: rosterdock }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          ports: [{ containerPort: 5432 }]
          readinessProbe:
            exec: { command: [pg_isready, -U, rosterdock, -d, rosterdock] }
            periodSeconds: 3
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests: { storage: 5Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector: { app: postgres }
  ports: [{ port: 5432 }]
EOF
# Local credentials only: the database is inside the namespace and reachable from nowhere else.
"${K[@]}" create secret generic rosterdock-db \
  --from-literal=DATABASE_URL="postgres://rosterdock:rosterdock@postgres.$NAMESPACE.svc:5432/rosterdock" \
  --dry-run=client -o yaml | "${K[@]}" apply -f -
# The fleet token is made once and kept, so a re-run does not strand live runs.
if ! "${K[@]}" get secret rosterdock-worker >/dev/null 2>&1; then
  "${K[@]}" create secret generic rosterdock-worker \
    --from-literal=ROSTERDOCK_WORKER_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
fi
"${K[@]}" rollout status statefulset/postgres --timeout=180s
# Ready once is not ready for good: a first start restarts the server after initdb.
for _ in $(seq 1 60); do
  "${K[@]}" exec postgres-0 -- psql -U rosterdock -d rosterdock -Atc "select 1" >/dev/null 2>&1 && break
  sleep 2
done

if [ "${IMPORT_LOCAL:-0}" = "1" ]; then
  say "the dev database into the cluster's"
  if [ "$("${K[@]}" exec postgres-0 -- psql -U rosterdock -d rosterdock -Atc "select to_regclass('public.companies') is not null")" = "t" ]; then
    echo "the cluster's database already has a board in it; nothing imported"
  else
    local_pg="$(cd "$ROOT" && docker compose ps -q postgres)"
    [ -n "$local_pg" ] || { echo "no dev Postgres running (pnpm db:up)" >&2; exit 1; }
    docker exec "$local_pg" pg_dump -U rosterdock -d rosterdock --no-owner --no-privileges \
      | "${K[@]}" exec -i postgres-0 -- psql -q -U rosterdock -d rosterdock -v ON_ERROR_STOP=1 >/dev/null
    echo "imported: $("${K[@]}" exec postgres-0 -- psql -U rosterdock -d rosterdock -Atc 'select count(*) from companies') companies"
  fi
fi

workers=()
token_b64="$("${K[@]}" get secret rosterdock-engines -o jsonpath='{.data.CLAUDE_CODE_OAUTH_TOKEN}' 2>/dev/null || true)"
# Checked for its shape only; the value is never printed.
# Counted rather than grepped: grep -q stops reading early, which pipefail can take for a failure.
spaces="$(printf %s "$token_b64" | base64 -d | LC_ALL=C tr -cd '[:space:]' | wc -c | tr -d ' ')"
if [ -n "$token_b64" ] && [ "$spaces" -gt 0 ]; then
  say "the Claude token in rosterdock-engines has spaces or line breaks in it (a copy of setup-token's wrapped output)"
  token_b64=""
fi
if [ -z "$token_b64" ]; then
  workers=(--set worker.replicas=0)
  say "no usable Claude token yet: the workers stay at zero and Peter plans by role until you add one"
  cat <<EOF
  claude setup-token
  read -rs TOKEN; TOKEN=\$(printf %s "\$TOKEN" | tr -d '[:space:]'); kubectl --context $CTX -n $NAMESPACE \\
    create secret generic rosterdock-engines --from-literal=CLAUDE_CODE_OAUTH_TOKEN="\$TOKEN" \\
    --dry-run=client -o yaml | kubectl --context $CTX -n $NAMESPACE apply -f -; unset TOKEN
  $0          # again, to start the workers and give the board the token
EOF
fi

say "helm upgrade --install $RELEASE"
# The images keep their tag from run to run; the build annotation rolls every pod onto the new ones.
helm --kube-context "$CTX" upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$CHART/examples/local.yaml" --set image.tag="$TAG" ${workers[@]+"${workers[@]}"} \
  --set-string "podAnnotations.rosterdock\.dev/build=$(date +%s)" \
  --wait --timeout 10m

say "up: $RELEASE in $NAMESPACE on $CTX"
"${K[@]}" get pods
cat <<EOF

Open it:
  kubectl --context $CTX -n $NAMESPACE port-forward svc/$RELEASE-web 8080:80
  http://localhost:8080   (dev login)
EOF
