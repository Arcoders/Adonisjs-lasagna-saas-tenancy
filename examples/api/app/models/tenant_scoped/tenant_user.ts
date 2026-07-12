import { DateTime } from 'luxon'
import hash from '@adonisjs/core/services/hash'
import { compose } from '@adonisjs/core/helpers'
import { column } from '@adonisjs/lucid/orm'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'
import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'

const AuthFinder = withAuthFinder(() => hash.use('scrypt'), {
  uids: ['email'],
  passwordColumnName: 'password',
})

/**
 * The tenant realm's identity. TenantBaseModel routes every query to the
 * resolved tenant's schema, so `users` and its `auth_access_tokens` exist once
 * per tenant: a login only ever sees the resolved tenant's rows, and the same
 * email can exist independently in two tenants. That per-schema storage is the
 * isolation guarantee the auth_realms e2e pins.
 *
 * The `tnt_` prefix is diagnostic only, same as `bko_` on the operator side.
 */
export default class TenantUser extends compose(TenantBaseModel, AuthFinder) {
  static table = 'users'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare email: string

  @column({ serializeAs: null })
  declare password: string

  @column()
  declare fullName: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  static accessTokens = DbAccessTokensProvider.forModel(TenantUser, {
    prefix: 'tnt_',
    expiresIn: '1 day',
  })
}
