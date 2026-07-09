import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

const updateSsoSchema = {
  clientId: vine.string().trim().minLength(1),
  clientSecret: vine.string().trim().minLength(1),
  issuerUrl: vine.string().url({ require_protocol: true }),
  redirectUri: vine.string().url({ require_protocol: true }),
  scopes: vine.array(vine.string().minLength(1)).optional(),
}

export const updateSsoValidator = vine.compile(
  vine.object(updateSsoSchema as ExactOptionalProps<typeof updateSsoSchema>)
)
