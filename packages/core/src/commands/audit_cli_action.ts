import app from '@adonisjs/core/services/app'
import AuditLogService from '../services/audit_log_service.js'

/** The subset of the ace command logger this helper needs. */
interface CommandLogger {
  warning(message: string): void
}

export interface AuditCliActionOptions {
  tenantId: string | null
  action: string
  /**
   * The acting operator id, from the command's `--admin` flag. When present the
   * row is attributed to that admin; when absent the action is recorded as
   * `system` (it ran from a privileged terminal with no admin attribution).
   */
  adminId?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

/**
 * Best-effort audit write for a CLI lifecycle command, the terminal-side twin of
 * the admin REST `auditAdminAction` helper. The mutation it records has already
 * happened, so a missing or unreachable audit table must never flip the command
 * to a misleading failure: it warns and moves on (same posture as the GDPR
 * anonymize command's `#record`). REST and CLI share one action name per
 * operation; only `actorType` distinguishes the caller.
 */
export async function auditCliAction(
  logger: CommandLogger,
  options: AuditCliActionOptions
): Promise<void> {
  try {
    const audit = await app.container.make(AuditLogService)
    await audit.log({
      tenantId: options.tenantId,
      actorType: options.adminId ? 'admin' : 'system',
      actorId: options.adminId ?? null,
      action: options.action,
      metadata: options.metadata,
    })
  } catch (error: any) {
    logger.warning(`Could not write the audit log entry: ${error?.message ?? 'unknown'}`)
  }
}
