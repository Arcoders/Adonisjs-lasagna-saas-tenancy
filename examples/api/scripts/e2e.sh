#!/usr/bin/env bash
# End-to-end runner — brings up Docker infra, runs the Japa e2e suite,
# tears down. Single command for adopters: `npm run test:e2e`.
#
# Flags:
#   --keep   Don't tear down infra after the suite (useful for debugging)
set -euo pipefail

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
  esac
done

cd "$(dirname "$0")/.."

# Ensure .env exists
if [[ ! -f .env ]]; then
  echo "[e2e] .env missing — copying from .env.example"
  cp .env.example .env
fi

cleanup() {
  if [[ $KEEP -eq 1 ]]; then
    echo "[e2e] --keep was passed; leaving infra running"
    return
  fi
  echo "[e2e] tearing down docker compose stack"
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[e2e] bringing up postgres + redis + pgadmin"
docker compose up -d

echo "[e2e] waiting for postgres to accept connections"
DEADLINE=$((SECONDS + 60))
until docker compose exec -T postgres pg_isready -U app -d lasagna_demo >/dev/null 2>&1; do
  if [[ $SECONDS -ge $DEADLINE ]]; then
    echo "[e2e] postgres did not become ready in 60s" >&2
    exit 1
  fi
  sleep 1
done

echo "[e2e] waiting for redis to accept connections"
DEADLINE=$((SECONDS + 30))
until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do
  if [[ $SECONDS -ge $DEADLINE ]]; then
    echo "[e2e] redis did not become ready in 30s" >&2
    exit 1
  fi
  sleep 1
done

# MailCatcher is optional — the e2e mail.spec.ts skips gracefully if it isn't
# reachable, so a probe failure here only emits a warning instead of aborting.
echo "[e2e] waiting for mailcatcher (optional)"
DEADLINE=$((SECONDS + 20))
MAILCATCHER_READY=0
while [[ $SECONDS -lt $DEADLINE ]]; do
  if curl -fs http://127.0.0.1:1080/messages >/dev/null 2>&1; then
    MAILCATCHER_READY=1
    break
  fi
  sleep 1
done
if [[ $MAILCATCHER_READY -eq 0 ]]; then
  echo "[e2e] mailcatcher not reachable — mail tests will skip"
fi

echo "[e2e] running backoffice:setup"
npx tsx ace.ts backoffice:setup

echo "[e2e] running Japa e2e suite"
npx tsx ace.ts test e2e
