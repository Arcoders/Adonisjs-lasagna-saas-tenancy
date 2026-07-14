import AuditLogService from '../../services/audit_log_service.js'
import AuditLogDestinationRegistry from '../../services/audit_log_destination_registry.js'
import ImpersonationService from '../../services/impersonation_service.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * Audit + impersonation plane. Register-only: the audit log service, its
 * host-populated destination registry (a Map, so it must be a singleton for a
 * host's registrations to be visible to the writers), and the impersonation
 * service. ImpersonationService resolves its optional audit log lazily from the
 * container inside `#audit()`, so its factory is sync, no longer the sole async
 * factory among the provider's singletons.
 */
export const auditWiring: ProviderInstaller = {
  name: 'audit',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(AuditLogService, () => new AuditLogService())
    ctx.app.container.singleton(
      AuditLogDestinationRegistry,
      () => new AuditLogDestinationRegistry()
    )
    ctx.app.container.singleton(ImpersonationService, () => new ImpersonationService())
  },
}
