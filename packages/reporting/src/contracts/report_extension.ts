/** Time-window filters handed to a report extension (all optional). */
export interface ReportExtensionFilters {
  since?: string
  until?: string
  period?: string
}

/**
 * A host-registered custom report. Register one in your provider's `boot()` via
 * the `ReportExtensionRegistry`, then run it from the CLI
 * (`tenant:report:generate --extension=<name>`) or the
 * `GET {prefix}/reports/extension/:name` endpoint.
 *
 * Built-in reporting reads the shared backoffice schema and never enters a
 * tenant scope. An extension that fans out across tenant schemas is the host's
 * responsibility — bound it with the `TenantQueueService.statsForTenants`-style
 * concurrency pattern and mind the connection budget (see docs/scaling-limits).
 */
export interface ReportExtension {
  /** Safe identifier (`/^[a-zA-Z0-9_-]{1,63}$/`); used in the CLI flag + URL. */
  readonly name: string
  readonly description: string
  execute(filters: ReportExtensionFilters, options?: Record<string, unknown>): Promise<unknown>
}
