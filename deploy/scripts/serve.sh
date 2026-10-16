#!/usr/bin/env bash
# An https origin for the local compose stack that only your own devices can reach, through Tailscale
# Serve: https://<this-machine>.<tailnet>.ts.net forwards to localhost:8080 with a real certificate.
#
#   deploy/scripts/serve.sh          # set up, write ROSTERDOCK_PUBLIC_URL to .env, print the URL
#   deploy/scripts/serve.sh off      # stop serving
#
# then:  docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
#
# Needs Tailscale installed and signed in on this machine, with MagicDNS and HTTPS certificates on for
# the tailnet (Tailscale prints the admin-console link the first time if they are not). Serve, unlike
# Funnel, never exposes anything to the internet: a device has to be signed into your tailnet to
# connect, so the dev login behind it is safe. OAuth callbacks work because the provider only redirects
# your browser to the URL, and your browser is on the tailnet.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
PORT="${PORT:-8080}"

TS="$(command -v tailscale || true)"
[ -n "$TS" ] || for c in "/c/Program Files/Tailscale/tailscale.exe" "/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
  [ -x "$c" ] && TS="$c" && break
done
[ -n "$TS" ] || { echo "tailscale is not installed (winget install Tailscale.Tailscale / https://tailscale.com/download)" >&2; exit 1; }

if [ "${1:-}" = "off" ]; then
  "$TS" serve reset
  echo "serve off"
  exit 0
fi

STATE="$("$TS" status --json 2>/dev/null | sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' | head -1)"
[ "$STATE" = "Running" ] || { echo "Tailscale is not signed in (state: ${STATE:-unknown}); open the Tailscale app and log in, then rerun" >&2; exit 1; }

DNS="$("$TS" status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
[ -n "$DNS" ] || { echo "no MagicDNS name for this machine; turn MagicDNS on in the admin console (DNS tab)" >&2; exit 1; }

# --bg keeps serving after this shell exits and survives reboots until `serve reset`. The first time on
# a tailnet, Tailscale prints an admin-console link to enable Serve and waits until it is clicked.
"$TS" serve --bg --https=443 "http://127.0.0.1:$PORT"
URL="https://$DNS"

touch "$ENV_FILE"
sed -i.bak '/^ROSTERDOCK_PUBLIC_URL=/d' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
printf 'ROSTERDOCK_PUBLIC_URL=%s\n' "$URL" >> "$ENV_FILE"

echo "serving $URL -> http://127.0.0.1:$PORT (tailnet only)"
echo "wrote ROSTERDOCK_PUBLIC_URL=$URL to .env"
echo
echo "next:  docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build"
echo "then open $URL from any device signed into your tailnet"
