import { pluginScope } from './plugin_execution_scope.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import UnauthorizedCoreAccessException from '../exceptions/unauthorized_core_access_exception.js'

/**
 * The core-access funnel. Called at the head of every sanctioned accessor for a
 * core singleton an untrusted plugin has no business touching: the host tenant
 * repository (`resolveTenantRepository`) and the shared db handle (`resolveDatabase`).
 * When UNTRUSTED plugin code is on the stack it emits `guard.plugin_core_access` and
 * throws {@link UnauthorizedCoreAccessException}; otherwise (core's own code, or a
 * trusted plugin) it is a no-op.
 *
 * This is the SINGLE throw-site for the guard, so the two accessors stay clean and
 * the Isthmus registry names one file. It is labeled friction, NOT a hard boundary:
 * a plugin that imports the db service or the repository symbol directly reaches
 * around it. The Postgres read-only role is what actually denies a write.
 *
 * `surface` is a short, developer-supplied label of what was refused (e.g.
 * `tenant-repository`, `database`); it rides the guard event metadata for triage.
 */
export function assertCoreAccessAllowed(surface: string): void {
  const ctx = pluginScope.current()
  if (ctx === undefined || ctx.trusted) return

  emitIsthmusEvent('guard.plugin_core_access', {
    metadata: { plugin: ctx.plugin, surface },
  })
  throw new UnauthorizedCoreAccessException(
    `refusing untrusted plugin "${ctx.plugin}" access to core "${surface}"`,
    { plugin: ctx.plugin }
  )
}
