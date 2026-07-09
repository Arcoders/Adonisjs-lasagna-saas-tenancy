import { column } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy'
import { encrypted, searchable, withEncryptedFields } from '../../src/index.js'

/**
 * Compile-only fixture: the `@encrypted` / `@searchable` ergonomic surface exactly as
 * the design (§6.4) documents it. It is deliberately NOT run (the tsx spec runner
 * rejects a decorated `declare` field; only `tsc` transforms the `@` sugar), so it
 * carries no `.spec.ts` name. It exists so a typecheck proves the `@` decorators and
 * the `compose(TenantBaseModel, withEncryptedFields)` typing compile as promised. The
 * RUNTIME proof (encrypt on save, decrypt on load, blind-index query, fail-closed
 * read after a shred) is `behavior_encrypted_decorator_real_pg.spec.ts`.
 */
export default class Renter extends compose(TenantBaseModel, withEncryptedFields) {
  @column({ isPrimary: true })
  declare id: string

  @encrypted({ category: 'identity-docs', subject: (row) => row.id })
  declare passportNumber: string | null

  @searchable({ category: 'identity-docs', from: (row) => row.passportNumber })
  declare passportNumberIndex: string | null
}
