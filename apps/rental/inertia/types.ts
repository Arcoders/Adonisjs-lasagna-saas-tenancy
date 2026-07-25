/**
 * Shared prop shapes mirrored from app/middleware/inertia_middleware.ts. Kept in
 * one place so pages and shells read a single source of truth.
 */
export type Operator = { id: string; email: string; fullName: string | null }
export type Staff = {
  id: string
  email: string
  fullName: string | null
  role: string
}

export type Company = {
  id: string
  name: string
  plan: string
  tier: string
  maintenance: boolean
}

export type SharedProps = {
  flash: Record<string, string | undefined>
  errors: Record<string, string>
  auth: {
    operator: Operator | null
    staff: Staff | null
  }
  company: Company | null
}

/** A tenant row as returned by the admin satellite (`GET /admin/tenants`). */
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'failed' | 'deleted'

export type AdminTenant = {
  id: string
  name: string
  email: string
  status: TenantStatus
  customDomain: string | null
  schemaName: string
  isActive: boolean
  isDeleted: boolean
  metadata: { plan?: string; tier?: string; country?: string; currency?: string } | null
  createdAt: string | null
  deletedAt: string | null
}
