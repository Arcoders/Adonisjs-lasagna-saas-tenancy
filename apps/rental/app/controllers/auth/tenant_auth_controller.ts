import type { HttpContext } from '@adonisjs/core/http'
import TenantUser from '#app/models/tenant_scoped/tenant_user'
import { loginValidator } from '#app/validators/auth_validator'

/**
 * The tenant realm's login surface. These routes live inside the tenant-guarded
 * group, so the company is already resolved (from `<slug>.localhost` or the
 * `x-tenant-id` header) when `verifyCredentials` runs and the lookup hits
 * `tenant_<uuid>.users`. The minted `tnt_` token is stored in that company's own
 * `auth_access_tokens`, so it is worthless against any other company.
 */
export default class TenantAuthController {
  async login({ request, response }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)
    const user = await TenantUser.verifyCredentials(email, password)
    const token = await TenantUser.accessTokens.create(user)
    if (!token.value) {
      throw new Error('unreachable: accessTokens.create() always returns a token value')
    }
    return response.ok({
      type: 'bearer',
      token: token.value.release(),
      expiresAt: token.expiresAt,
    })
  }

  async me({ auth, request, response }: HttpContext) {
    const user = auth.use('tenant').getUserOrFail()
    const tenant = await request.tenant()
    return response.ok({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      tenantId: tenant.id,
    })
  }

  async logout({ auth, response }: HttpContext) {
    const user = auth.use('tenant').getUserOrFail()
    await TenantUser.accessTokens.delete(user, user.currentAccessToken.identifier)
    return response.ok({ revoked: true })
  }
}
