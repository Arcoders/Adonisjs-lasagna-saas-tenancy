import PluginException from './plugin_exception.js'

/**
 * Thrown when UNTRUSTED plugin code reaches for a core singleton it is not
 * allowed to touch: the host tenant repository (cross-tenant enumeration/mutation)
 * or the shared database handle, reached through the sanctioned core-access funnels
 * (`resolveTenantRepository`, `resolveDatabase`). A 403: the plugin is authenticated
 * (installed) but not authorized for core access.
 *
 * READ HONESTLY: this is IN-PROCESS FRICTION, not a hard boundary. It raises
 * the cost of a careless or opportunistic reach, but a plugin that imports the db
 * service or the repository symbol directly bypasses it. The real, Postgres-enforced
 * containment is the read-only role that denies a write regardless of which JS
 * path the query took. See `.github/SECURITY.md`.
 */
export default class UnauthorizedCoreAccessException extends PluginException {
  static status = 403
  static code = 'E_UNAUTHORIZED_CORE_ACCESS'
}
