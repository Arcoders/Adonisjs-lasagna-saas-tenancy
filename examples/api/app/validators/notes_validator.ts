import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

const createNoteSchema = {
  title: vine.string().trim().minLength(1).maxLength(200),
  body: vine.string().trim().maxLength(10_000).nullable().optional(),
}

export const createNoteValidator = vine.compile(
  vine.object(createNoteSchema as ExactOptionalProps<typeof createNoteSchema>)
)
