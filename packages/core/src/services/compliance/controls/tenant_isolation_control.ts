import type { ComplianceControl } from '../types.js'

const EVIDENCE: Record<string, string> = {
  'schema-pg':
    'Driver "schema-pg": each tenant gets its own PostgreSQL schema (tenant_<uuid>) on a ' +
    'shared database. Cross-schema access requires explicit qualification.',
  'database-pg':
    'Driver "database-pg": each tenant gets its own PostgreSQL database — OS/process-level ' +
    'separation, the strongest isolation Lasagna offers.',
  'rowscope-pg':
    'Driver "rowscope-pg": shared schema with a tenant_id predicate injected on every query; ' +
    'strict mode throws on an unscoped query. Weaker than schema/database isolation.',
  'sqlite-memory':
    'Driver "sqlite-memory": in-memory, test-only. NOT an isolation posture for production.',
}

/**
 * Which isolation driver is active, and what separation it actually buys. Always
 * informative (a driver is always selected). `sqlite-memory` is flagged because
 * it is a test fixture, not a production posture.
 */
const tenantIsolationControl: ComplianceControl = {
  id: 'tenant-isolation',
  title: 'Tenant data isolation',
  frameworks: ['soc2:CC6.1', 'soc2:C1', 'gdpr:art32', 'iso:A.5.15', 'hipaa:164.312(a)'],

  detect({ config }) {
    const driver = config.isolation?.driver ?? 'schema-pg'
    const evidence = EVIDENCE[driver] ?? `Driver "${driver}".`

    if (driver === 'sqlite-memory') {
      return {
        status: 'action-needed',
        evidence,
        hostResponsibility: 'Select schema-pg, database-pg, or rowscope-pg for production.',
        remediation: 'Set multitenancy.config.isolation.driver to a PostgreSQL driver.',
      }
    }

    return {
      status: 'satisfied',
      evidence,
      hostResponsibility:
        'For rowscope-pg, audit every cross-tenant query and keep rowScopeMode strict. ' +
        'For per-tenant residency requirements, prefer database-pg.',
    }
  },
}

export default tenantIsolationControl
