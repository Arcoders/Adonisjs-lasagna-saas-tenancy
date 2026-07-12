import type { HttpContext } from '@adonisjs/core/http'
import BackofficeUser from '#app/models/backoffice/backoffice_user'
import { loginValidator } from '#app/validators/auth_validator'

/**
 * The operator realm's login surface. Mounted under `router.central()` in
 * start/routes.ts: operators authenticate on the apex, never inside a tenant
 * context. The minted `bko_` token is what the admin API, `/metrics` and the
 * reporting dashboard expect as a bearer.
 */
export default class BackofficeAuthController {
  async login({ request, response }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)
    const user = await BackofficeUser.verifyCredentials(email, password)
    const token = await BackofficeUser.accessTokens.create(user)
    if (!token.value) {
      throw new Error('unreachable: accessTokens.create() always returns a token value')
    }
    return response.ok({
      type: 'bearer',
      token: token.value.release(),
      expiresAt: token.expiresAt,
    })
  }

  async me({ auth, response }: HttpContext) {
    const user = auth.use('backoffice').getUserOrFail()
    return response.ok({ id: user.id, email: user.email, fullName: user.fullName })
  }

  async logout({ auth, response }: HttpContext) {
    const user = auth.use('backoffice').getUserOrFail()
    await BackofficeUser.accessTokens.delete(user, user.currentAccessToken.identifier)
    return response.ok({ revoked: true })
  }
}
