import vine from '@vinejs/vine'

export const updateBrandingValidator = vine.compile(
  vine.object({
    fromName: vine.string().trim().maxLength(100).nullable().optional(),
    fromEmail: vine.string().trim().email().nullable().optional(),
    logoUrl: vine.string().url({ require_protocol: true }).nullable().optional(),
    primaryColor: vine
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    supportUrl: vine.string().url({ require_protocol: true }).nullable().optional(),
    emailFooter: vine.record(vine.any()).nullable().optional(),
  })
)
