import vine from '@vinejs/vine'

export const updateSsoValidator = vine.compile(
  vine.object({
    clientId: vine.string().trim().minLength(1),
    clientSecret: vine.string().trim().minLength(1),
    issuerUrl: vine.string().url({ require_protocol: true }),
    redirectUri: vine.string().url({ require_protocol: true }),
    scopes: vine.array(vine.string().minLength(1)).optional(),
  })
)
