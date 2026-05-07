import vine from '@vinejs/vine'

export const setFlagValidator = vine.compile(
  vine.object({
    flag: vine.string().trim().minLength(1).maxLength(100),
    enabled: vine.boolean().optional(),
    config: vine.record(vine.any()).optional(),
  })
)
