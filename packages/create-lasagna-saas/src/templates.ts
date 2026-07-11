/**
 * The files `configure` does not write.
 *
 * `node ace configure @adonisjs-lasagna/saas-tenancy` publishes the tenant model,
 * the repository, the provider and the migrations, but it never touches
 * `config/database.ts`. That file belongs to Lucid. Two details of it are load
 * bearing and both have silently broken installs before:
 *
 *   1. `searchPath` sits BESIDE `connection` on the connection node, not inside
 *      it. Nested, it does not typecheck, and every query silently stays on the
 *      `public` schema. All three install docs got this wrong at one point.
 *   2. A `tenant` template connection must exist. SchemaPgDriver clones it for
 *      each `tenant_<uuid>` connection; without it, provisioning dies with
 *      "template connection not found".
 *
 * Rendering them here is the reason this scaffolder exists. Everything else it
 * does, a reader could copy from the quickstart.
 */

/** Keep in step with the connection names `configure` writes into config/multitenancy.ts. */
const CENTRAL = 'public'
const BACKOFFICE = 'backoffice'
const TENANT_TEMPLATE = 'tenant'

/**
 * A PostgreSQL database name derived from the app directory. Postgres folds
 * unquoted identifiers to lower case and rejects a leading digit, so normalise
 * rather than hand the raw directory name to `CREATE DATABASE`.
 */
export function databaseName(directory: string): string {
  const slug = directory
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (slug === '' || /^[0-9]/.test(slug)) return `app_${slug}`
  return slug
}

/**
 * `config/database.ts` with the three connection contexts the package documents:
 * the central connection, the shared backoffice schema, and the per-tenant
 * template. Values read from env with defaults, so a fresh clone boots without a
 * populated `.env`.
 */
export function databaseConfig(): string {
  return `import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const baseConnection = {
  host: env.get('DB_HOST', '127.0.0.1'),
  port: Number(env.get('DB_PORT', 5432)),
  user: env.get('DB_USER', 'postgres'),
  password: env.get('DB_PASSWORD', ''),
  database: env.get('DB_DATABASE', 'postgres'),
}

export default defineConfig({
  connection: '${CENTRAL}',
  connections: {
    // The central connection. Models extending CentralBaseModel land here.
    ${CENTRAL}: {
      client: 'pg' as const,
      connection: baseConnection,
      searchPath: ['${CENTRAL}'],
    },

    // The shared backoffice schema: the tenants table and every satellite table.
    // Migrations run against this connection via \`node ace backoffice:setup\`.
    ${BACKOFFICE}: {
      client: 'pg' as const,
      connection: baseConnection,
      searchPath: ['${BACKOFFICE}'],
      migrations: { naturalSort: true, paths: ['database/migrations'] },
    },

    // The template SchemaPgDriver clones for every tenant_<uuid> connection.
    // It is never queried directly. Removing it breaks tenant provisioning.
    ${TENANT_TEMPLATE}: {
      client: 'pg' as const,
      connection: baseConnection,
      searchPath: ['${CENTRAL}'],
    },
  },
})
`
}

/**
 * The env keys the generated `config/database.ts` and the queue/cache
 * bootstrappers read. Appended to the `.env` that create-adonisjs wrote, and to
 * `.env.example` so the keys survive a fresh clone.
 */
export function envBlock(directory: string): string {
  return `
# Multitenancy
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=
DB_DATABASE=${databaseName(directory)}
QUEUE_REDIS_HOST=127.0.0.1
QUEUE_REDIS_PORT=6379
CACHE_REDIS_HOST=127.0.0.1
CACHE_REDIS_PORT=6379
`
}
