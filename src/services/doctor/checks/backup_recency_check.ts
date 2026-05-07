import BackupService from '../../backup_service.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const STALE_DAYS = 7

const backupRecencyCheck: DoctorCheck = {
  name: 'backup_recency',
  description: `Warns when an active tenant has no backup in the last ${STALE_DAYS} day(s) or none at all.`,

  async run(ctx): Promise<DiagnosisIssue[]> {
    const svc = new BackupService()
    const issues: DiagnosisIssue[] = []
    const cutoff = Date.now() - STALE_DAYS * 86400_000

    for (const tenant of ctx.tenants) {
      if (!tenant.isActive) continue
      try {
        const list = await svc.listBackups(tenant.id)
        if (list.length === 0) {
          issues.push({
            code: 'backup_never_taken',
            severity: 'warn',
            message: `Active tenant "${tenant.name}" has no backups recorded`,
            tenantId: tenant.id,
          })
          continue
        }
        const latest = Math.max(...list.map((b) => Date.parse(b.timestamp)))
        if (Number.isFinite(latest) && latest < cutoff) {
          const ageDays = Math.floor((Date.now() - latest) / 86400_000)
          issues.push({
            code: 'backup_stale',
            severity: 'warn',
            message: `Latest backup of "${tenant.name}" is ${ageDays} day(s) old`,
            tenantId: tenant.id,
            meta: { latest: new Date(latest).toISOString(), ageDays },
          })
        }
      } catch (error: any) {
        issues.push({
          code: 'backup_inspect_failed',
          severity: 'info',
          message: `Could not inspect backups for "${tenant.name}": ${error?.message ?? 'unknown'}`,
          tenantId: tenant.id,
        })
      }
    }

    return issues
  },
}

export default backupRecencyCheck
