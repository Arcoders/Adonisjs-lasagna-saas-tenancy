import type { MultitenancyConfig } from '../../types/config.js'
import type { IsolationDriver } from './driver.js'
import SchemaPgDriver from './schema_pg_driver.js'
import DatabasePgDriver from './database_pg_driver.js'
import RowScopePgDriver from './rowscope_pg_driver.js'
import SqliteMemoryDriver from './sqlite_memory_driver.js'

/**
 * The built-in isolation drivers, keyed by name, each a factory from the
 * multitenancy config to a ready driver instance. The provider's `boot()`
 * looks the configured `isolation.driver` up here and registers the result,
 * so this map is the single source of truth for which drivers activate
 * automatically. Adding a sixth built-in is one map entry, not a fifth branch
 * in the provider (Open/Closed): `boot()` never grows a per-driver `if`.
 *
 * The factories carry ONLY construction (reading the config a driver needs).
 * Driver-adjacent boot concerns that are not construction stay in the provider:
 * the rowscope-pg RLS acknowledgment warning and the RLS-catalog probe are about
 * the ACTIVE driver's runtime posture, not about building the instance, so they
 * do not belong here.
 *
 * Optional fields are spread conditionally (`...(x !== undefined ? {...} : {})`)
 * so `exactOptionalPropertyTypes` stays satisfied: a `templateConnectionName:
 * undefined` is not the same as an omitted key.
 */
export const BUILT_IN_ISOLATION_DRIVERS: Record<
  string,
  (config: MultitenancyConfig) => IsolationDriver
> = {
  'schema-pg': (config) =>
    new SchemaPgDriver({
      ...(config.isolation?.templateConnectionName !== undefined
        ? { templateConnectionName: config.isolation.templateConnectionName }
        : {}),
    }),
  'database-pg': (config) =>
    new DatabasePgDriver({
      ...(config.isolation?.templateConnectionName !== undefined
        ? { templateConnectionName: config.isolation.templateConnectionName }
        : {}),
      ...(config.isolation?.tenantDatabasePrefix !== undefined
        ? { databasePrefix: config.isolation.tenantDatabasePrefix }
        : {}),
    }),
  'rowscope-pg': (config) =>
    new RowScopePgDriver({
      // rowscope-pg shares one connection across all tenants, the central one.
      // templateConnectionName is a clone-template concept only schema-pg /
      // database-pg use, so rowscope reads centralConnectionName instead.
      centralConnectionName: config.centralConnectionName,
      ...(config.isolation?.rowScopeTables !== undefined
        ? { scopedTables: config.isolation.rowScopeTables }
        : {}),
      ...(config.isolation?.rowScopeColumn !== undefined
        ? { scopeColumn: config.isolation.rowScopeColumn }
        : {}),
    }),
  'sqlite-memory': () => new SqliteMemoryDriver(),
}

/**
 * The names of the drivers that activate automatically (the map keys). Kept as
 * a named export so a test or diagnostic can enumerate the built-ins from the
 * same single source `boot()` registers from.
 */
export const BUILT_IN_ISOLATION_DRIVER_NAMES: readonly string[] = Object.keys(
  BUILT_IN_ISOLATION_DRIVERS
)
