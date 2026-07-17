import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

/**
 * Validates the body of the operator's "create company" form. `slug` becomes
 * the vanity host `<slug>.localhost` (stored as `custom_domain`); plan/tier/
 * country/currency default in the service. The `@email` business rule stays in
 * the `beforeProvision` hook so the hook-abort path is exercised.
 */
const createTenantSchema = {
  name: vine.string().trim().minLength(2).maxLength(100),
  email: vine.string().trim().email(),
  slug: vine
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    .minLength(2)
    .maxLength(40)
    .optional(),
  plan: vine.enum(['starter', 'fleet', 'enterprise'] as const).optional(),
  tier: vine.enum(['standard', 'premium'] as const).optional(),
  country: vine.string().trim().fixedLength(2).toUpperCase().optional(),
  currency: vine.string().trim().fixedLength(3).toUpperCase().optional(),
}

export const createTenantValidator = vine.compile(
  vine.object(createTenantSchema as ExactOptionalProps<typeof createTenantSchema>)
)

/** ?keepSchema=true on DELETE /admin/tenants/:id */
const destroyTenantQuerySchema = {
  keepSchema: vine.boolean().optional(),
}

export const destroyTenantQueryValidator = vine.compile(
  vine.object(destroyTenantQuerySchema as ExactOptionalProps<typeof destroyTenantQuerySchema>)
)
