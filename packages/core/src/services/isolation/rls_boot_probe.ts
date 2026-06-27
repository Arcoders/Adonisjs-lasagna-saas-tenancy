import IsolationConfigException from '../../exceptions/isolation_config_exception.js'

/**
 * One row of the RLS catalog probe for a scoped table: whether Row-Level
 * Security is enabled, whether it is FORCED (the table owner bypasses RLS
 * otherwise, and apps usually connect as the owner), and how many policies
 * exist. Sourced from `pg_class.relrowsecurity` / `relforcerowsecurity` and
 * `pg_policies` by the boot probe.
 */
export interface RlsCatalogRow {
  table: string
  rowSecurity: boolean
  forceRowSecurity: boolean
  policyCount: number
}

/**
 * WS-5 / rowscope-acknowledgment-flag-no-verification.
 *
 * `isolation.rowScopeRls: true` is the operator ASSERTING they ran the
 * `enable_rls_tenant_isolation` migration so RLS is the real isolation backstop.
 * Before this, nothing checked the claim — the flag only silenced a boot warning,
 * so a half-applied migration left the escapable `withTenantScope` mixin as the
 * ONLY boundary while the config implied a hard one.
 *
 * This pure helper turns the claim into a checked invariant: every scoped table
 * must have RLS ENABLED, FORCED, and at least one policy. It throws
 * `IsolationConfigException` (500, not a retry-able 503 — a deploy fix is
 * required) naming the first unprotected table. Pure (no db/app) so it is
 * unit-testable; the boot probe supplies the catalog rows.
 */
export function assertRowScopeRlsPresent(catalogRows: RlsCatalogRow[], tables: string[]): void {
  const byTable = new Map(catalogRows.map((r) => [r.table, r]))
  for (const table of tables) {
    const row = byTable.get(table)
    if (!row) {
      throw new IsolationConfigException(
        `isolation.rowScopeRls is true but scoped table "${table}" was not found in the RLS ` +
          `catalog probe. Did the enable_rls_tenant_isolation migration run for it?`
      )
    }
    const missing: string[] = []
    if (!row.rowSecurity) missing.push('ROW LEVEL SECURITY is not ENABLED')
    if (!row.forceRowSecurity) missing.push('it is not FORCED (the table owner bypasses RLS)')
    if (row.policyCount < 1) missing.push('it has no RLS policy')
    if (missing.length > 0) {
      throw new IsolationConfigException(
        `isolation.rowScopeRls is true but scoped table "${table}": ${missing.join('; ')}. ` +
          `Run the enable_rls_tenant_isolation migration (configure --with=rls) for every ` +
          `rowScopeTables entry, or set rowScopeRls=false to drop the claim.`
      )
    }
  }
}

/**
 * Impure companion: read the RLS catalog state for `tables` in `schema` from the
 * given Lucid connection. Kept separate from {@link assertRowScopeRlsPresent} so
 * the decision stays unit-testable; the provider boot probe pairs them.
 */
export async function probeRlsCatalog(
  db: { connection(name: string): { rawQuery(sql: string, bindings?: unknown[]): Promise<any> } },
  connectionName: string,
  schema: string,
  tables: string[]
): Promise<RlsCatalogRow[]> {
  const result = await db.connection(connectionName).rawQuery(
    `SELECT c.relname AS table,
            c.relrowsecurity AS row_security,
            c.relforcerowsecurity AS force_row_security,
            (SELECT count(*) FROM pg_policies p
               WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policy_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ? AND c.relkind = 'r' AND c.relname = ANY(?)`,
    [schema, tables]
  )
  const rows = (result.rows ?? result) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    table: String(r.table),
    rowSecurity: r.row_security === true || r.row_security === 't',
    forceRowSecurity: r.force_row_security === true || r.force_row_security === 't',
    policyCount: Number(r.policy_count ?? 0),
  }))
}
