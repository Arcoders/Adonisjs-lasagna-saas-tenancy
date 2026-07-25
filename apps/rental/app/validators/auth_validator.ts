import vine from '@vinejs/vine'

/**
 * Shared by both realms' login endpoints. Shape only; the credential check
 * itself is `verifyCredentials` in the controllers.
 */
export const loginValidator = vine.compile(
  vine.object({
    email: vine.string().email(),
    password: vine.string(),
  })
)
