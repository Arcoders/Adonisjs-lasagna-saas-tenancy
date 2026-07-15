import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
import { DateTime } from 'luxon'
import { encrypted, searchable, withEncryptedFields } from '@adonisjs-lasagna/crypto'

/**
 * A tenant-scoped model with a crypto `@encrypted` field, backing the crypto e2e.
 * `compose(TenantBaseModel, withEncryptedFields)` keeps the per-tenant schema routing
 * (rows live in `tenant_<uuid>.secure_notes`) and wires the transparent encrypt/decrypt
 * hooks: `secret` is stored as enc_v2 ciphertext and round-trips as plaintext in
 * memory, while `secretIndex` holds its keyed-HMAC blind index for equality search.
 *
 *   POST /demo/secure-notes  encrypts `secret` under the (subject × 'demo-secret') DEK
 *   GET  /demo/secure-notes  decrypts on load
 *   after a crypto-shred of the subject, loading the row fails closed (never surfaces
 *   the inert ciphertext as if it were plaintext).
 */
const CATEGORY = 'demo-secret'

export default class SecureNote extends compose(TenantBaseModel, withEncryptedFields) {
  static table = 'secure_notes'

  @column({ isPrimary: true })
  declare id: string

  // The data-subject key the DEK is derived from and a crypto-shred targets.
  @column()
  declare subject: string

  // Transparently encrypted at rest; @encrypted replaces @column for this field.
  @encrypted({ category: CATEGORY, subject: (row) => row.subject })
  declare secret: string | null

  // The blind index for `secret`, recomputed on every write, queried on search.
  @searchable({ category: CATEGORY, from: (row) => row.secret })
  declare secretIndex: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
