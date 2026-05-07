import vine from '@vinejs/vine'

export const trackQuotaValidator = vine.compile(
  vine.object({
    quota: vine.string().trim().minLength(1),
    amount: vine.number().positive().optional(),
  })
)
