import { assertSafeIdentifier } from '../services/isolation/identifier.js'
import { getConfig } from '../config.js'

/**
 * Build a fully-qualified, double-quoted `"schema"."table"` reference for a table in
 * the shared backoffice schema. Both identifiers are validated with the same strict
 * policy the tenant drivers use ({@link assertSafeIdentifier}), so neither can escape
 * the quoting.
 *
 * This is THE single place a raw-SQL caller turns a bare table name plus the
 * operator-configured backoffice schema into a SQL-safe qualified name. No module may
 * hardcode the literal `backoffice.` prefix (the `check-no-hardcoded-backoffice`
 * guard enforces this): a host that renames the schema via
 * `config.backofficeSchemaName` must be honored everywhere the shared WORM ledger and
 * the AI audit write, or those fail-closed writers 503 on a renamed-backoffice host.
 * `audit_immutability_control.ts` documents the same hazard for the trigger check.
 *
 * Pure and bare-safe (no booted import), so the barrel-free hash-chain writers can
 * call it from their own unit runners. The schema is operator config, validated once
 * at wiring, not attacker-controlled per request.
 */
export function qualifyBackofficeTable(schema: string, table: string): string {
  assertSafeIdentifier(schema, 'backoffice schema name')
  assertSafeIdentifier(table, 'backoffice table name')
  return `"${schema}"."${table}"`
}

/**
 * Convenience over {@link qualifyBackofficeTable} that reads the configured backoffice
 * schema from the booted config singleton. For core call sites that already depend on
 * `getConfig()`; the barrel-free satellite writers (WORM ledger, AI audit) receive the
 * schema through their injected deps and call {@link qualifyBackofficeTable} directly
 * so they never value-import the config module.
 */
export function backofficeTable(table: string): string {
  return qualifyBackofficeTable(getConfig().backofficeSchemaName, table)
}
