#!/usr/bin/env bash
#
# The gate that matters: prove a stranger can install this package.
#
# Every other gate in this repo runs against the workspace, where
# `@adonisjs-lasagna/saas-tenancy` is a symlink to `packages/core`. That symlink
# hides the whole class of defect this script exists to catch: a root entry that
# forgets to export the configure hook, a stub that ships but cannot render, a
# stub calling an Application method that does not exist, a missing migration.
# All four were live when this script was written, with 46 other gates green.
#
# So: pack the tarball, scaffold a real AdonisJS 7 app, install the tarball into
# it, and drive the documented golden path end to end.
#
#   configure -> typecheck -> backoffice:setup -> tenant:create -> queue:work
#                                                              -> status = active
#
# Needs PostgreSQL and Redis. Override the defaults below; CI points them at its
# service containers, a laptop at the local compose stack. No psql required: the
# database assertions run through the `pg` driver the generated app installs.
#
# Usage: bash scripts/clean-install-smoke.sh
set -euo pipefail

PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-postgres}"
PG_DATABASE="${PG_DATABASE:-lasagna_clean_install}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
APP_DIR="$WORK_DIR/app"
WORKER_PID=""

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

cleanup() {
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# A tiny psql stand-in. It lives INSIDE the generated app because ESM resolves
# bare specifiers from the module's own path, not from the cwd, and `pg` is only
# in the app's node_modules.
#   node db-smoke.mjs <database> "<sql>"  -> first column of the first row
# ---------------------------------------------------------------------------
write_db_helper() {
  cat > "$APP_DIR/db-smoke.mjs" <<'EOF'
import pg from 'pg'

const [database, sql] = process.argv.slice(2)
const client = new pg.Client({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database,
})
await client.connect()
try {
  const { rows } = await client.query(sql)
  if (rows.length > 0) process.stdout.write(String(Object.values(rows[0])[0] ?? ''))
} finally {
  await client.end()
}
EOF
}

db() { (cd "$APP_DIR" && PG_HOST="$PG_HOST" PG_PORT="$PG_PORT" PG_USER="$PG_USER" \
  PG_PASSWORD="$PG_PASSWORD" node "$APP_DIR/db-smoke.mjs" "$1" "$2"); }

log "Packing the tarball"
cd "$REPO_ROOT"
npm run build >/dev/null
TARBALL_NAME="$(npm pack --workspace @adonisjs-lasagna/saas-tenancy --pack-destination "$WORK_DIR" --silent | tail -1)"
TARBALL="$WORK_DIR/$TARBALL_NAME"
[ -f "$TARBALL" ] || fail "npm pack produced no tarball"

log "Scaffolding a fresh AdonisJS 7 app"
cd "$WORK_DIR"
# Destination and --kit are the only two prompts; passing both makes it
# non-interactive. --skip-migrations: the kit's sqlite migrations are irrelevant.
npm init adonisjs@latest -- app --kit=api --pkg=npm --skip-migrations >/dev/null 2>&1 \
  || fail "create-adonisjs failed"
write_db_helper

log "Installing the packed tarball (not the workspace symlink)"
cd "$APP_DIR"
# pg + redis + queue are peers the golden path needs; the api kit ships none.
# --legacy-peer-deps: the kit pins @adonisjs/session 8 while core's optional peer
# range says 7, which npm treats as a hard conflict.
npm install pg @adonisjs/redis @adonisjs/queue "$TARBALL" --legacy-peer-deps >/dev/null 2>&1 \
  || fail "installing the tarball failed"

log "Configuring the peer packages"
node ace configure @adonisjs/redis </dev/null >/dev/null 2>&1 || fail "configure @adonisjs/redis failed"
# Prompts for a driver; a bare newline accepts the default (redis).
printf '\n' | node ace configure @adonisjs/queue >/dev/null 2>&1 || fail "configure @adonisjs/queue failed"

log "node ace configure @adonisjs-lasagna/saas-tenancy"
CONFIGURE_OUT="$(node ace configure @adonisjs-lasagna/saas-tenancy 2>&1)" || {
  echo "$CONFIGURE_OUT"; fail "configure exited non-zero"
}
echo "$CONFIGURE_OUT"

# `configure` exits 0 even when the hook is missing — it only warns. So assert on
# the artifacts, which is this gate's whole reason to exist.
case "$CONFIGURE_OUT" in
  *"does not export the configure hook"*) fail "the package exports no configure hook" ;;
esac
for f in config/multitenancy.ts \
         app/models/backoffice/tenant.ts \
         app/repositories/tenant_repository.ts \
         providers/tenancy_provider.ts; do
  [ -f "$f" ] || fail "configure did not publish $f"
done
ls database/migrations/*_create_tenants_table.ts >/dev/null 2>&1 \
  || fail "configure did not publish the tenants migration"

# The tenants migration must sort first: `--with=maintenance` ALTERs that table.
FIRST_MIGRATION="$(ls database/migrations | sort | head -1)"
case "$FIRST_MIGRATION" in
  *_create_tenants_table.ts) ;;
  *) fail "the tenants migration does not sort first (got $FIRST_MIGRATION)" ;;
esac

log "Pointing the app at Postgres and Redis"
# The three connection contexts the quickstart documents. Their names must match
# config/multitenancy.ts: `public` is centralConnectionName, `backoffice` is
# backofficeConnectionName, and `tenant` is the template SchemaPgDriver clones
# for every tenant_<uuid> connection.
cat > config/database.ts <<'EOF'
import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const baseConnection = {
  host: env.get('DB_HOST', '127.0.0.1'),
  port: Number(env.get('DB_PORT', 5432)),
  user: env.get('DB_USER', 'postgres'),
  password: env.get('DB_PASSWORD', ''),
  database: env.get('DB_DATABASE', 'postgres'),
}

export default defineConfig({
  connection: 'public',
  connections: {
    public: {
      client: 'pg' as const,
      connection: baseConnection,
      searchPath: ['public'],
    },
    backoffice: {
      client: 'pg' as const,
      connection: baseConnection,
      searchPath: ['backoffice'],
      migrations: { naturalSort: true, paths: ['database/migrations'] },
    },
    tenant: {
      client: 'pg' as const,
      connection: baseConnection,
      searchPath: ['public'],
    },
  },
})
EOF

# Rewrite the two keys the redis configure hard-coded, then append ours. dotenv
# takes the last definition of a key, but rewriting in place keeps the file honest.
sed -i "s|^REDIS_HOST=.*|REDIS_HOST=$REDIS_HOST|; s|^REDIS_PORT=.*|REDIS_PORT=$REDIS_PORT|" .env
cat >> .env <<EOF

# Multitenancy
DB_HOST=$PG_HOST
DB_PORT=$PG_PORT
DB_USER=$PG_USER
DB_PASSWORD=$PG_PASSWORD
DB_DATABASE=$PG_DATABASE
QUEUE_REDIS_HOST=$REDIS_HOST
QUEUE_REDIS_PORT=$REDIS_PORT
CACHE_REDIS_HOST=$REDIS_HOST
CACHE_REDIS_PORT=$REDIS_PORT
EOF

log "Resetting database $PG_DATABASE"
db postgres "DROP DATABASE IF EXISTS $PG_DATABASE" >/dev/null
db postgres "CREATE DATABASE $PG_DATABASE" >/dev/null

log "Typechecking the generated app"
npx tsc --noEmit || fail "the code configure generated does not typecheck"

log "node ace backoffice:setup"
node ace backoffice:setup || fail "backoffice:setup failed"

log "node ace tenant:create"
node ace tenant:create "Acme Corp" "admin@acme.example.com" || fail "tenant:create failed"

TENANT_ID="$(db "$PG_DATABASE" "SELECT id FROM backoffice.tenants WHERE email = 'admin@acme.example.com'")"
[ -n "$TENANT_ID" ] || fail "tenant:create wrote no row to backoffice.tenants"
log "Tenant $TENANT_ID created"

log "node ace queue:work — draining the InstallTenant job"
node ace queue:work >"$WORK_DIR/worker.log" 2>&1 &
WORKER_PID=$!

STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(db "$PG_DATABASE" "SELECT status FROM backoffice.tenants WHERE id = '$TENANT_ID'")"
  [ "$STATUS" = "active" ] && break
  [ "$STATUS" = "failed" ] && break
  kill -0 "$WORKER_PID" 2>/dev/null || { cat "$WORK_DIR/worker.log"; fail "queue:work died"; }
  sleep 1
done

if [ "$STATUS" != "active" ]; then
  cat "$WORK_DIR/worker.log"
  fail "tenant never reached status 'active' (last seen: '${STATUS:-<none>}')"
fi

# Provisioning is only real if the tenant's own schema exists. The name is the
# prefix plus the RAW uuid, dashes and all — that is what SchemaPgDriver creates.
# Read pg_namespace, not information_schema.schemata: the latter hides schemas the
# current role does not own and would report a false negative.
SCHEMA_NAME="tenant_$TENANT_ID"
FOUND="$(db "$PG_DATABASE" "SELECT 1 FROM pg_namespace WHERE nspname = '$SCHEMA_NAME'")"
[ "$FOUND" = "1" ] || fail "tenant is active but schema $SCHEMA_NAME does not exist"

log "PASS — tenant $TENANT_ID is active and owns schema $SCHEMA_NAME"
