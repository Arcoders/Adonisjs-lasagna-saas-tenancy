import type { PluginReadOnlyConfig } from '../types/config.js'

/**
 * Suffix appended to a tenant's primary connection name to form its read-only
 * variant. The variant is a separate Lucid connection (separate pool) so setting
 * it read-only never interferes with the primary tenant pool.
 */
export const READ_ONLY_CONNECTION_SUFFIX = '__plugin_ro'

/**
 * Clone a primary tenant connection config into a read-only variant: same client,
 * pool sizing, ssl, and — critically — the TOP-LEVEL `searchPath` (schema-pg's
 * `[tenant_<uuid>]`), overriding ONLY the credentials with the read-only role.
 *
 * Mirrors the read-replica clone exactly, including the searchPath subtlety: knex
 * reads `config.searchPath`, not `config.connection.searchPath`, so spreading the
 * whole primary config (not just `connection`) carries the tenant schema onto the
 * read-only connection. database-pg's primary intentionally has no searchPath (its
 * data lives in the tenant database's own `public`), and that absence is preserved
 * too — we never fabricate one.
 */
export function buildReadOnlyConnectionConfig(
  primary: unknown,
  role: PluginReadOnlyConfig
): Record<string, unknown> {
  const p = primary && typeof primary === 'object' ? (primary as Record<string, unknown>) : {}
  const baseConnection =
    p.connection && typeof p.connection === 'object'
      ? (p.connection as Record<string, unknown>)
      : {}
  return {
    ...p,
    client: typeof p.client === 'string' ? p.client : 'pg',
    connection: {
      ...baseConnection,
      user: role.user,
      password: role.password ?? baseConnection.password,
    },
  }
}
