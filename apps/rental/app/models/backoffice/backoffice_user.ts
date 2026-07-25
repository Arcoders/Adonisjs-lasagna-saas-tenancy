import { DateTime } from 'luxon'
import hash from '@adonisjs/core/services/hash'
import { compose } from '@adonisjs/core/helpers'
import { column } from '@adonisjs/lucid/orm'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'
import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'

const AuthFinder = withAuthFinder(() => hash.use('scrypt'), {
  uids: ['email'],
  passwordColumnName: 'password',
})

/**
 * The operator realm's identity — Karimoto platform staff. Lives in
 * `backoffice.backoffice_users`, one fleet-wide table, because
 * BackofficeBaseModel pins every query to the backoffice connection. Access
 * tokens follow the model's adapter, so they land in
 * `backoffice.auth_access_tokens`, never inside a tenant schema.
 *
 * The `bko_` prefix is diagnostic only (a leaked token names its realm at a
 * glance). No security decision branches on it.
 */
export default class BackofficeUser extends compose(BackofficeBaseModel, AuthFinder) {
  static table = 'backoffice_users'

  @column({ isPrimary: true })
  declare id: string

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

  static accessTokens = DbAccessTokensProvider.forModel(BackofficeUser, {
    prefix: 'bko_',
    expiresIn: '1 day',
  })
}
