import vine from '@vinejs/vine'

export const subscribeWebhookValidator = vine.compile(
  vine.object({
    url: vine.string().url({ require_protocol: true }),
    events: vine.array(vine.string().minLength(1)).minLength(1),
    secret: vine.string().minLength(8).maxLength(255).nullable().optional(),
  })
)

export const fireWebhookValidator = vine.compile(
  vine.object({
    event: vine.string().minLength(1),
    payload: vine.record(vine.any()).optional(),
  })
)
