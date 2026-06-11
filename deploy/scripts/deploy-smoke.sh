#!/usr/bin/env bash
# Deploy smoke test: boots the CI-verified compose topology
# (deploy/docker-compose.e2e.yml â€” Postgres primary + streaming replica,
# password-protected Redis, 2 app replicas + queue worker behind nginx) and
# proves the deployment claims the docs make:
#
#   1. /livez and /readyz answer 200 through the proxy once the stack is up
#   2. queue-driven tenant provisioning completes (worker, not inline)
#   3. tenant isolation holds through nginx (A's notes invisible to B)
#   4. reads on the demo's `_read` connection are served by the streaming replica
#   5. stopping the primary flips tenant requests AND /readyz to 503
#      while /livez stays 200; restarting it recovers without intervention
#   6. a misconfigured container (no APP_KEY) dies at boot naming the variable
#
# Bash-only (CI runner, WSL, Git Bash). Requires docker compose v2 and curl.
# CI passes LASAGNA_DEMO_IMAGE (pre-built); without it the script builds
# examples/api/Dockerfile itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../docker-compose.e2e.yml"
DC=(docker compose -f "$COMPOSE_FILE")
BASE_URL="${SMOKE_BASE_URL:-http://localhost}"

log() { printf '\n=== %s\n' "$*"; }
fail() { printf 'SMOKE FAILURE: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    log "dumping compose logs (exit $status)"
    "${DC[@]}" logs --no-color --tail 200 || true
  fi
  "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

# poll <timeout-seconds> <description> <command...>
poll() {
  local deadline=$(( $(date +%s) + $1 )); shift
  local desc="$1"; shift
  until "$@" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "timed out waiting for: $desc"
    fi
    sleep 2
  done
  log "ok: $desc"
}

http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect_code() { test "$(http_code "${@:2}")" = "$1"; }

# ---------------------------------------------------------------------------
log "bringing the stack up"
UP_ARGS=(up -d --wait --wait-timeout 300)
if [ -z "${LASAGNA_DEMO_IMAGE:-}" ]; then
  UP_ARGS+=(--build)
fi
"${DC[@]}" "${UP_ARGS[@]}"

# ---------------------------------------------------------------------------
log "probes through nginx"
poll 60 "GET /livez is 200" expect_code 200 "$BASE_URL/livez"
poll 60 "GET /readyz is 200" expect_code 200 "$BASE_URL/readyz"
readyz_body="$(curl -s "$BASE_URL/readyz")"
echo "$readyz_body" | grep -q '"backoffice_db"' || fail "/readyz report does not include the backoffice_db check: $readyz_body"
echo "$readyz_body" | grep -q '"redis"' || fail "/readyz report does not include the redis check: $readyz_body"

log "backoffice setup (idempotent)"
"${DC[@]}" exec -T app node --import=@poppinss/ts-exec ace.ts backoffice:setup

# ---------------------------------------------------------------------------
# create_tenant <name> -> echoes the tenant id. Provisioning is queued; the
# worker service must pick it up â€” this is the path the prod template was
# missing entirely before it gained a worker.
create_tenant() {
  local name="$1"
  local response tenant_id
  response="$(curl -s -X POST "$BASE_URL/demo/tenants" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"$name\",\"email\":\"$name@smoke.test\",\"plan\":\"pro\",\"tier\":\"premium\"}")"
  tenant_id="$(echo "$response" | grep -oE '"tenantId":\s*"[^"]+"' | cut -d'"' -f4)"
  [ -n "$tenant_id" ] || fail "could not create tenant $name: $response"
  poll 90 "tenant $name reaches active via the queue worker" \
    sh -c "curl -s '$BASE_URL/demo/tenants/$tenant_id' | grep -q '\"status\":\\s*\"active\"'"
  "${DC[@]}" exec -T app node --import=@poppinss/ts-exec ace.ts tenant:migrate --tenant "$tenant_id" >/dev/null
  echo "$tenant_id"
}

log "queue-driven provisioning of two tenants"
TENANT_A="$(create_tenant smoke-a | tail -n 1)"
TENANT_B="$(create_tenant smoke-b | tail -n 1)"
log "tenant A: $TENANT_A | tenant B: $TENANT_B"

# ---------------------------------------------------------------------------
log "tenant isolation through the proxy"
expect_code 201 -X POST "$BASE_URL/demo/notes" \
  -H 'content-type: application/json' -H "x-tenant-id: $TENANT_A" \
  -d '{"title":"smoke-note-a"}' || fail "could not create a note as tenant A"

notes_b="$(curl -s "$BASE_URL/demo/notes" -H "x-tenant-id: $TENANT_B")"
echo "$notes_b" | grep -q 'smoke-note-a' && fail "ISOLATION BREACH: tenant B sees tenant A's note: $notes_b"
notes_a="$(curl -s "$BASE_URL/demo/notes" -H "x-tenant-id: $TENANT_A")"
echo "$notes_a" | grep -q 'smoke-note-a' || fail "tenant A cannot read back its own note: $notes_a"
log "ok: A's note exists for A and is invisible to B"

# ---------------------------------------------------------------------------
log "read path through the streaming replica (DB_REPLICA_HOST=postgres-replica)"
poll 30 "replica serves tenant A's note (streaming lag tolerated)" \
  sh -c "curl -s '$BASE_URL/demo/notes/read' -H 'x-tenant-id: $TENANT_A' | grep -q 'smoke-note-a'"

# ---------------------------------------------------------------------------
log "outage drill: stopping postgres-primary"
"${DC[@]}" stop postgres-primary >/dev/null

poll 60 "tenant request fails closed with 503" \
  expect_code 503 "$BASE_URL/demo/notes" -H "x-tenant-id: $TENANT_A"
poll 60 "/readyz drops to 503 (critical backoffice_db check)" \
  expect_code 503 "$BASE_URL/readyz"
expect_code 200 "$BASE_URL/livez" || fail "/livez must stay 200 during a dependency outage â€” liveness never depends on Postgres"
log "ok: /livez stayed 200 while /readyz and tenant traffic returned 503"

log "recovery: starting postgres-primary"
"${DC[@]}" start postgres-primary >/dev/null
poll 120 "/readyz recovers to 200" expect_code 200 "$BASE_URL/readyz"
poll 120 "tenant traffic recovers to 200" \
  expect_code 200 "$BASE_URL/demo/notes" -H "x-tenant-id: $TENANT_A"

# ---------------------------------------------------------------------------
log "misconfigured deploy fails fast (container without APP_KEY)"
set +e
misconfig_output="$("${DC[@]}" run --rm --no-deps --entrypoint sh app \
  -c 'unset APP_KEY; exec node --import=@poppinss/ts-exec bin/server.ts' 2>&1)"
misconfig_rc=$?
set -e
[ "$misconfig_rc" -ne 0 ] || fail "a container without APP_KEY booted successfully â€” env validation is not failing fast"
echo "$misconfig_output" | grep -q 'APP_KEY' || fail "boot failure does not name APP_KEY:\n$misconfig_output"
log "ok: boot without APP_KEY exited $misconfig_rc naming the variable"

log "ALL DEPLOY SMOKE CHECKS PASSED"
