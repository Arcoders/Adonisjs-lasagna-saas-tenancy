/**
 * Shared failure formatter for the per-tenant migration commands
 * (`tenant:migrate`, `tenant:migrate:fresh`, `tenant:migrate:rollback`,
 * `migration:tenant:run`, `migration:tenant:rollback`).
 *
 * The underlying error message is ALWAYS surfaced — hiding it behind
 * `--verbose` forces the operator to re-run a failed deploy just to see
 * what broke (the same diagnosability gap `backoffice:setup` fixed in F-4).
 * Not a command itself: it is not listed in commands.json, and it imports
 * nothing, so the unit suite can exercise it directly.
 */
export function migrationTaskError(task: { error: (message: string) => any }, error: unknown): any {
  const message = error instanceof Error ? error.message : String(error)
  return task.error(message || 'failed')
}
