import type { ComplianceControl } from '../types.js'
import { DEFAULT_SOFT_DELETE_RETENTION_DAYS } from '../../../utils/soft_delete.js'

/**
 * Is a data-retention window configured for deleted tenants? Soft delete keeps a
 * tenant's schema for `softDelete.retentionDays`, after which `tenant:purge-expired`
 * drops it. An unset value still has a working default, so absence is info, not a
 * failure, but making it explicit is the auditable posture.
 */
const dataRetentionControl: ComplianceControl = {
  id: 'data-retention',
  title: 'Data retention & deletion window',
  frameworks: ['soc2:CC8.1', 'gdpr:art17', 'gdpr:art5', 'iso:A.8.10', 'hipaa:164.312(c)(1)'],

  detect({ config }) {
    const configured = config.softDelete?.retentionDays

    if (typeof configured === 'number') {
      return {
        status: 'satisfied',
        evidence:
          `softDelete.retentionDays = ${configured}. tenant:destroy soft-deletes; ` +
          'tenant:purge-expired drops schemas past the window.',
        hostResponsibility:
          'Schedule tenant:purge-expired on a cron, and run audit-log retention separately.',
      }
    }

    return {
      status: 'info',
      evidence:
        'softDelete.retentionDays is not set; the built-in default of ' +
        `${DEFAULT_SOFT_DELETE_RETENTION_DAYS} days applies when tenant:purge-expired runs.`,
      hostResponsibility:
        'Set softDelete.retentionDays explicitly to document the window, and schedule ' +
        'tenant:purge-expired on a cron.',
    }
  },
}

export default dataRetentionControl
