/** Time-window filters handed to a report extension (all optional). */
export interface ReportExtensionFilters {
  since?: string | undefined
  until?: string | undefined
  period?: string | undefined
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
 * concurrency pattern and mind the connection budget (see docs/guides/scaling-limits.md).
 */
export interface ReportExtension {
  /** Safe identifier (`/^[a-zA-Z0-9_-]{1,63}$/`); used in the CLI flag + URL. */
  readonly name: string
  readonly description: string
  /**
   * The extension-contract version this report was built against (see
   * `REPORTING_CONTRACT_VERSION`). Optional: an absent version registers with a
   * one-time "unversioned" warning, never a failure, so extensions written
   * before versioning existed keep working. Declare it to opt into the
   * compatibility check.
   */
  readonly contractVersion?: number
  /**
   * Run the report. `signal` aborts when the configured `timeoutMs` elapses —
   * thread it into your `fetch`/queries so a slow report can unwind instead of
   * holding a connection past the deadline (the timeout is a response deadline,
   * not forced cancellation). Optional and backward-compatible: ignore it and
   * the report simply isn't cancellable.
   */
  execute(
    filters: ReportExtensionFilters,
    options?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown>
}
