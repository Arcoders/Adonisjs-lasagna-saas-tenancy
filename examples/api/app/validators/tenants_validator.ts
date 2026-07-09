import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

/**
 * Validates the body of POST /demo/tenants. Optional fields default to
 * `'free'` / `'standard'` in the service layer.
 *
 * NB: the demo-side `.test`-suffix rule is intentionally left to the
 * `beforeProvision` hook in `config/multitenancy.ts` — it's a business
 * rule, not a shape rule. Keeping the validator focused on shape lets the
 * hook test (which proves the hook fires and flips status=failed) keep
 * working as documented.
 */
const createTenantSchema = {
  name: vine.string().trim().minLength(2).maxLength(100),
  email: vine.string().trim().email(),
  plan: vine.enum(['free', 'pro'] as const).optional(),
  tier: vine.enum(['standard', 'premium'] as const).optional(),
}

export const createTenantValidator = vine.compile(
  vine.object(createTenantSchema as ExactOptionalProps<typeof createTenantSchema>)
)

/** ?keepSchema=true on DELETE /demo/tenants/:id */
const destroyTenantQuerySchema = {
  keepSchema: vine.boolean().optional(),
}

export const destroyTenantQueryValidator = vine.compile(
  vine.object(destroyTenantQuerySchema as ExactOptionalProps<typeof destroyTenantQuerySchema>)
)
