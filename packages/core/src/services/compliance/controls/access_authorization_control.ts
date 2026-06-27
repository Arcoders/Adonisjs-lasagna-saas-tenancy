import type { ComplianceControl } from '../types.js'

/**
 * Is the tenant-access membership gate wired? Tenant resolution is trust-the-input;
 * without `authorizeTenantAccess` (or an equivalent host middleware) a swapped
 * tenant id is the classic cross-tenant IDOR. We can only see the package hook,
 * so an unset hook is action-needed — the host may still gate it elsewhere.
 */
const accessAuthorizationControl: ComplianceControl = {
  id: 'access-authorization',
  title: 'Tenant access authorization (membership gate)',
  frameworks: ['soc2:CC6.1', 'gdpr:art32', 'iso:A.5.15', 'hipaa:164.312(a)(1)'],

  detect({ config }) {
    if (typeof config.authorizeTenantAccess === 'function') {
      return {
        status: 'satisfied',
        evidence:
          'config.authorizeTenantAccess is wired; TenantGuardMiddleware denies a caller who ' +
          'does not belong to the resolved tenant with a 403.',
        hostResponsibility:
          'Keep full RBAC/roles in your own policies; routes that skip the guard, jobs, and ' +
          'tenancy.run() scopes are not covered by this hook.',
      }
    }

    if (config.acknowledgeNoMembershipGate === true) {
      return {
        status: 'info',
        evidence:
          'config.authorizeTenantAccess is not set, but acknowledgeNoMembershipGate is true: the ' +
          'host explicitly accepted the cross-tenant IDOR risk (membership enforced elsewhere or ' +
          'out of scope).',
        hostResponsibility:
          'You opted out of the package membership gate. Ensure an equivalent app-layer guard ' +
          'verifies the principal belongs to the resolved tenant, or remove the acknowledgement.',
      }
    }

    return {
      status: 'action-needed',
      evidence:
        'config.authorizeTenantAccess is not set. If you have no equivalent app-layer guard, a ' +
        'swapped x-tenant-id is served against another tenant (cross-tenant IDOR).',
      hostResponsibility:
        'Wire authorizeTenantAccess or an equivalent middleware verifying the principal belongs ' +
        'to the resolved tenant.',
      remediation: 'Add authorizeTenantAccess to config/multitenancy.ts (see the Security guide).',
    }
  },
}

export default accessAuthorizationControl
