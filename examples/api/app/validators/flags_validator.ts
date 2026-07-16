import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

const setFlagSchema = {
  flag: vine.string().trim().minLength(1).maxLength(100),
  enabled: vine.boolean().optional(),
  config: vine.record(vine.any()).optional(),
}

export const setFlagValidator = vine.compile(
  vine.object(setFlagSchema as ExactOptionalProps<typeof setFlagSchema>)
)
