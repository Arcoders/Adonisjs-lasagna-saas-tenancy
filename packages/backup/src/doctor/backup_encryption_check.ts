import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * The shape of the backup config this check needs. Kept structural (not the full
 * core config type) so {@link evaluateBackupEncryption} stays a pure function
 * unit tests can call without a booted app.
 */
export interface BackupEncryptionConfigView {
  storagePath?: string
  s3?: { enabled?: boolean }
}

/**
 * Pure evaluation of the at-rest encryption posture of backups. The package
 * never encrypts dumps itself (pg_dump output is written verbatim), so this is
 * an advisory: it surfaces WHERE the operator must ensure encryption, so a
 * production deployment does not ship plaintext tenant data by omission.
 */
export function evaluateBackupEncryption(
  cfg: BackupEncryptionConfigView | undefined
): DiagnosisIssue[] {
  if (!cfg) return []
  if (cfg.s3?.enabled) {
    return [
      {
        code: 'backup_s3_encryption_unverified',
        severity: 'info',
        message:
          'Backups upload to S3. Ensure bucket-level encryption at rest (SSE-S3 or SSE-KMS) ' +
          'is enabled on the bucket; this package does not encrypt objects itself. The dump is ' +
          `also written to local disk first (${cfg.storagePath ?? 'storagePath'}) before upload, ` +
          'so that volume and its directory permissions must be protected too.',
      },
    ]
  }
  return [
    {
      code: 'backup_local_encryption_unverified',
      severity: 'info',
      message:
        `Backups are stored on local disk (${cfg.storagePath ?? 'storagePath'}). Ensure the ` +
        'volume is encrypted at rest and the directory permissions are restricted to the app ' +
        'user; this package does not encrypt dumps itself.',
    },
  ]
}

const backupEncryptionCheck: DoctorCheck = {
  name: 'backup_encryption',
  description:
    'Advises on at-rest encryption for backups (S3 SSE or local disk encryption); the package ' +
    'does not encrypt dumps itself.',

  async run(): Promise<DiagnosisIssue[]> {
    // Lazy import so this module loads in a bare unit runner (the core /config
    // barrel touches app.booted at import time).
    const { getConfig } = await import('@adonisjs-lasagna/saas-tenancy/config')
    return evaluateBackupEncryption(getConfig().backup)
  },
}

export default backupEncryptionCheck
