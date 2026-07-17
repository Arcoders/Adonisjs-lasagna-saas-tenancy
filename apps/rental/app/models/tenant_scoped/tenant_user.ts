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

/** A company staff member's role: the owner administers the account, agents
 * run the counter (bookings, customers, fleet). */
export type TenantUserRole = 'owner' | 'agent'

/**
 * The tenant realm's identity — a rental company's staff. TenantBaseModel
 * routes every query to the resolved tenant's schema, so `users` and its
 * `auth_access_tokens` exist once per company: a login only ever sees the
 * resolved company's rows, and the same email can exist independently in two
 * companies. That per-schema storage is the isolation guarantee.
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

  @column()
  declare role: TenantUserRole

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  static accessTokens = DbAccessTokensProvider.forModel(TenantUser, {
    prefix: 'tnt_',
    expiresIn: '1 day',
  })
}
