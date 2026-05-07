import vine from '@vinejs/vine'

export const createNoteValidator = vine.compile(
  vine.object({
    title: vine.string().trim().minLength(1).maxLength(200),
    body: vine.string().trim().maxLength(10_000).nullable().optional(),
  })
)
