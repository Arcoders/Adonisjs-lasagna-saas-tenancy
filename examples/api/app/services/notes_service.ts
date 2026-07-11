import { tenantLogger } from '@adonisjs-lasagna/saas-tenancy/services'
import type Tenant from '#app/models/backoffice/tenant'

export interface CreateNoteInput {
  title: string
  // `| undefined` (not just `?`) so the validator's optional output, which is
  // `string | null | undefined`, passes under exactOptionalPropertyTypes.
  body?: string | null | undefined
}

interface NoteRow {
  id: number
  title: string
  body: string | null
  created_at: string
}

interface ReplicaListResult {
  readFrom: string
  isReplica: boolean
  notes: NoteRow[]
}

const SELECT_NOTES_SQL = 'SELECT id, title, body, created_at FROM notes ORDER BY id DESC'
const INSERT_NOTE_SQL =
  'INSERT INTO notes (title, body) VALUES (?, ?) RETURNING id, title, body, created_at'

/**
 * Demonstrates raw-SQL access against a tenant's per-schema connection. We
 * use rawQuery rather than a Lucid model on `notes` because the schema is
 * created on the fly per tenant and we want the controllers to read like a
 * minimal worked example. Real apps usually extend `TenantBaseModel`.
 *
 * Takes the concrete Tenant model (controllers narrow once through
 * `currentTenant()` in app/helpers/current_tenant.ts) so the connection
 * methods are typed instead of cast at every use.
 */
export default class NotesService {
  async list(tenant: Tenant): Promise<NoteRow[]> {
    const result = await tenant.getConnection().rawQuery(SELECT_NOTES_SQL)
    ;(await tenantLogger()).info({ count: result.rows.length }, 'listed notes')
    return result.rows
  }

  async listFromReplica(tenant: Tenant): Promise<ReplicaListResult> {
    // getReadConnection falls back to the primary internally when no
    // replica host is configured.
    const conn = await tenant.getReadConnection()
    const result = await conn.rawQuery(SELECT_NOTES_SQL)
    return {
      readFrom: conn.connectionName,
      isReplica: conn.connectionName.endsWith('_read_0'),
      notes: result.rows,
    }
  }

  async create(tenant: Tenant, input: CreateNoteInput): Promise<NoteRow> {
    // knex's bindings type rejects `null` literals; cast at the call site
    // because rawQuery passes them through to pg unchanged.
    const bindings = [input.title, input.body ?? null] as unknown as string[]
    const result = await tenant.getConnection().rawQuery(INSERT_NOTE_SQL, bindings)
    const row = result.rows[0] as NoteRow
    ;(await tenantLogger()).info({ noteId: row.id }, 'note created')
    return row
  }
}
