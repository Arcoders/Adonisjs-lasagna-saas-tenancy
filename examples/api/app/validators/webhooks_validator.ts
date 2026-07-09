import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

const subscribeWebhookSchema = {
  url: vine.string().url({ require_protocol: true }),
  events: vine.array(vine.string().minLength(1)).minLength(1),
  secret: vine.string().minLength(8).maxLength(255).nullable().optional(),
}

export const subscribeWebhookValidator = vine.compile(
  vine.object(subscribeWebhookSchema as ExactOptionalProps<typeof subscribeWebhookSchema>)
)

const fireWebhookSchema = {
  event: vine.string().minLength(1),
  payload: vine.record(vine.any()).optional(),
}

export const fireWebhookValidator = vine.compile(
  vine.object(fireWebhookSchema as ExactOptionalProps<typeof fireWebhookSchema>)
)
