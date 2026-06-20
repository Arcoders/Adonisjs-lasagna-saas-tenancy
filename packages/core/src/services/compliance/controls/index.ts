export { default as auditImmutabilityControl } from './audit_immutability_control.js'
export { default as secretEncryptionControl } from './secret_encryption_control.js'
export { default as tenantIsolationControl } from './tenant_isolation_control.js'
export { default as accessAuthorizationControl } from './access_authorization_control.js'
export { default as dataRetentionControl } from './data_retention_control.js'

import auditImmutabilityControl from './audit_immutability_control.js'
import secretEncryptionControl from './secret_encryption_control.js'
import tenantIsolationControl from './tenant_isolation_control.js'
import accessAuthorizationControl from './access_authorization_control.js'
import dataRetentionControl from './data_retention_control.js'
import type { ComplianceControl } from '../types.js'

export const builtInControls: ComplianceControl[] = [
  tenantIsolationControl,
  accessAuthorizationControl,
  secretEncryptionControl,
  auditImmutabilityControl,
  dataRetentionControl,
]
