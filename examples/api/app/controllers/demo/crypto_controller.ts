import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { randomUUID } from 'node:crypto'
import { EncryptedRepository, CryptoException } from '@adonisjs-lasagna/crypto'
import SecureNote from '#app/models/tenant_scoped/secure_note'

const CATEGORY = 'demo-secret'

/**
 * The crypto satellite's HTTP surface for the e2e suite. It exercises field
 * encryption end to end through the booted server and the per-tenant schema:
 *
 *   POST /demo/secure-notes           encrypt `secret` under (subject × demo-secret)
 *   GET  /demo/secure-notes/:subject  decrypt on load (410 once the DEK is shredded)
 *   POST /demo/secure-notes/search    equality search via the keyed-HMAC blind index
 *   POST /demo/secure-notes/:subject/shred   crypto-shred the (subject × category) DEK
 *
 * The blind-index build and the shred go through the container `EncryptedRepository`,
 * which resolves the CURRENT tenant fail-closed (a DEK is never resolved under a
 * guessed tenant). Cross-tenant isolation is structural: a request routes to
 * `tenant_<uuid>.secure_notes`, so tenant B never sees tenant A's rows.
 */
@inject()
export default class CryptoController {
  constructor(private readonly repo: EncryptedRepository) {}

  /** Encrypt + index a secret for a subject (the model hooks do the crypto). */
  async create({ request, response }: HttpContext) {
    const { subject, secret } = request.only(['subject', 'secret'])
    const note = new SecureNote()
    note.id = randomUUID()
    note.subject = String(subject)
    note.secret = secret === undefined || secret === null ? null : String(secret)
    await note.save()
    return response.created({ id: note.id, subject: note.subject })
  }

  /** Read one subject's secret, decrypted. 410 once its DEK has been shredded. */
  async show({ params, response }: HttpContext) {
    try {
      const note = await SecureNote.query().where('subject', params.subject).first()
      if (!note) return response.notFound({ error: 'not_found' })
      return response.ok({ id: note.id, subject: note.subject, secret: note.secret })
    } catch (error) {
      // The DEK was shredded (or a value tampered): fail closed. NEVER surface the
      // inert ciphertext as if it were plaintext — the resource is Gone.
      if (error instanceof CryptoException) {
        return response.status(410).json({ error: 'unrecoverable', code: error.code })
      }
      throw error
    }
  }

  /** Equality search over the encrypted field via its blind index (crypto owns the HMAC). */
  async search({ request, response }: HttpContext) {
    const { value } = request.only(['value'])
    const index = await this.repo.blindIndex(CATEGORY, String(value))
    const rows = await SecureNote.query().where('secret_index', index)
    return response.ok({
      matches: rows.map((r) => ({ id: r.id, subject: r.subject, secret: r.secret })),
    })
  }

  /** Crypto-shred the (subject × category) DEK (gated by the erasability resolver). */
  async shred({ params, response }: HttpContext) {
    try {
      const result = await this.repo.shred(params.subject, CATEGORY)
      return response.ok(result)
    } catch (error) {
      // A refused shred (governance said the category is not erasable, or no ledger
      // is wired) is a deliberate fail-closed 403, not a server error.
      if (error instanceof CryptoException && error.code === 'shred_refused') {
        return response.status(403).json({ error: 'shred_refused', message: error.message })
      }
      throw error
    }
  }
}
