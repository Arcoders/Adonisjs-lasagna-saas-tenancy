import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

const trackQuotaSchema = {
  quota: vine.string().trim().minLength(1),
  amount: vine.number().positive().optional(),
}

export const trackQuotaValidator = vine.compile(
  vine.object(trackQuotaSchema as ExactOptionalProps<typeof trackQuotaSchema>)
)
