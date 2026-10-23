#!/usr/bin/env bash
# Install RosterDock from the chart into a throwaway namespace on the current kubectl context and check it
# answers. Meant for a local cluster (kind, k3d, Docker Desktop, minikube): builds the images locally,
# runs a single-pod Postgres and MinIO in the namespace, installs the chart against them with the network
# policies on, waits for the board and web to be ready, and curls /api/health and /api/ready through a
# port-forward. Leaves the release up unless KEEP=0.
#
#   deploy/scripts/smoke.sh                     # uses the current context; namespace rosterdock-smoke
#   NAMESPACE=rosterdock-smoke KEEP=0 deploy/scripts/smoke.sh
#   KIND=1 deploy/scripts/smoke.sh              # create a kind cluster first and load the images into it
#
# Needs: docker, kubectl, helm. With KIND=1: kind.
set -euo pipefail

NAMESPACE="${NAMESPACE:-rosterdock-smoke}"
RELEASE="${RELEASE:-rosterdock}"
KEEP="${KEEP:-1}"
TAG="${TAG:-smoke}"
HELM="${HELM:-helm}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHART="$ROOT/deploy/helm/rosterdock"

say() { printf '\n== %s\n' "$*"; }

say "building images rosterdock-board:$TAG rosterdock-web:$TAG rosterdock-worker:$TAG"
docker build -q -t "rosterdock-board:$TAG" -f "$ROOT/apps/board/Dockerfile" "$ROOT"
docker build -q -t "rosterdock-web:$TAG" -f "$ROOT/apps/web/Dockerfile" "$ROOT"
docker build -q -t "rosterdock-worker:$TAG" -f "$ROOT/apps/worker/Dockerfile" "$ROOT"

if [ "${KIND:-0}" = "1" ]; then
  say "kind cluster rosterdock-smoke"
  kind get clusters | grep -qx rosterdock-smoke || kind create cluster --name rosterdock-smoke
  kubectl config use-context kind-rosterdock-smoke
  kind load docker-image --name rosterdock-smoke "rosterdock-board:$TAG" "rosterdock-web:$TAG" "rosterdock-worker:$TAG"
fi

say "namespace $NAMESPACE with Postgres, MinIO and the secrets"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: postgres
  labels: { app: postgres }
spec:
  containers:
    - name: postgres
      image: postgres:16-alpine
      env:
        - { name: POSTGRES_USER, value: rosterdock }
        - { name: POSTGRES_PASSWORD, value: rosterdock }
        - { name: POSTGRES_DB, value: rosterdock }
      ports: [{ containerPort: 5432 }]
      readinessProbe:
        exec: { command: [pg_isready, -U, rosterdock, -d, rosterdock] }
        periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector: { app: postgres }
  ports: [{ port: 5432 }]
---
apiVersion: v1
kind: Pod
metadata:
  name: minio
  labels: { app: minio }
spec:
  containers:
    - name: minio
      image: cgr.dev/chainguard/minio:latest
      args: [server, /data]
      env:
        - { name: MINIO_ROOT_USER, value: rosterdock }
        - { name: MINIO_ROOT_PASSWORD, value: rosterdock-smoke-only }
      ports: [{ containerPort: 9000 }]
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes: [{ name: data, emptyDir: {} }]
---
apiVersion: v1
kind: Service
metadata:
  name: minio
spec:
  selector: { app: minio }
  ports: [{ port: 9000 }]
EOF
# Smoke credentials only; a real install creates these from its secret store (docs/install.md).
kubectl -n "$NAMESPACE" create secret generic rosterdock-db \
  --from-literal=DATABASE_URL="postgres://rosterdock:rosterdock@postgres.$NAMESPACE.svc:5432/rosterdock" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create secret generic rosterdock-worker \
  --from-literal=ROSTERDOCK_WORKER_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create secret generic rosterdock-engines --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create secret generic rosterdock-storage \
  --from-literal=S3_ACCESS_KEY=rosterdock --from-literal=S3_SECRET_KEY=rosterdock-smoke-only \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod/postgres --timeout=180s

# The images keep the same tag from run to run; the build-time annotation makes every run roll every pod.
say "helm upgrade --install $RELEASE"
"$HELM" upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" \
  --set image.registry=docker.io/library --set image.tag="$TAG" --set image.pullPolicy=IfNotPresent \
  --set postgres.externalSecret.name=rosterdock-db \
  --set storage.endpoint="http://minio.$NAMESPACE.svc:9000" --set storage.externalSecret.name=rosterdock-storage \
  --set storage.port=9000 \
  --set board.devLogin=true \
  --set networkPolicy.enabled=true \
  --set-string "podAnnotations.rosterdock\.dev/smoke-build=$(date +%s)" \
  --wait --timeout 5m

say "the board answers"
kubectl -n "$NAMESPACE" port-forward "svc/$RELEASE-web" 18080:80 >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18080/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:18080/api/health && echo
curl -fsS http://127.0.0.1:18080/api/ready && echo
curl -fsS -o /dev/null -w 'web: %{http_code}\n' http://127.0.0.1:18080/
# The page is revalidated on every load, or an upgrade keeps serving the old bundle.
curl -fsSI http://127.0.0.1:18080/ | grep -qi '^cache-control: no-cache' ||
  { echo "web: / is served without Cache-Control: no-cache" >&2; exit 1; }
curl -fsS -X POST -H 'content-type: application/json' -d '{"email":"smoke@example.com","name":"Smoke"}' \
  http://127.0.0.1:18080/api/auth/dev-login | head -c 120 && echo

say "ok: $RELEASE is up in $NAMESPACE"
kubectl -n "$NAMESPACE" get pods
if [ "$KEEP" != "1" ]; then
  say "cleaning up"
  "$HELM" uninstall "$RELEASE" -n "$NAMESPACE" || true
  kubectl delete namespace "$NAMESPACE" --wait=false || true
fi
