/**
 * Guardrail: refuse a cross-tenant reporting query that is running inside a
 * tenant scope, where it could leak another tenant's data into a tenant context.
 * Reporting must run from a backoffice context (a queue job, scheduled task, or
 * admin endpoint), never inside `tenancy.run()`.
 *
 * Lives in its own dependency-free module (it imports nothing from core or
 * Lucid) so it stays unit-testable without an Ignitor (importing the reporting
 * service pulls in `@adonisjs/lucid/services/db`, which top-level-`await`s
 * `app.booted`). Callers pass the current-tenant getter (`tenancy.currentId`).
 */
export function assertNotInTenantScope(
  operation: string,
  currentId: () => string | undefined
): void {
  if (currentId()) {
    throw new Error(
      `ReportingService.${operation}(): refusing to aggregate cross-tenant data inside a tenant ` +
        `scope (data-leak guard). Run reporting from a backoffice context, not inside tenancy.run().`
    )
  }
}
