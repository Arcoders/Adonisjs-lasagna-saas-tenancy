import { tenantLogger } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { DemoMeta } from '#app/models/backoffice/tenant'

export interface CreateNoteInput {
  title: string
  body?: string | null
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
 */
export default class NotesService {
  async list(tenant: TenantModelContract<DemoMeta>): Promise<NoteRow[]> {
    const result = await tenant.getConnection().rawQuery(SELECT_NOTES_SQL)
    ;(await tenantLogger()).info({ count: result.rows.length }, 'listed notes')
    return result.rows
  }

  async listFromReplica(
    tenant: TenantModelContract<DemoMeta>
  ): Promise<ReplicaListResult> {
    // Falls back to the primary connection when no replica is configured OR
    // when the tenant model doesn't implement the optional method.
    const conn = tenant.getReadConnection
      ? await tenant.getReadConnection()
      : tenant.getConnection()
    const result = await conn.rawQuery(SELECT_NOTES_SQL)
    return {
      readFrom: conn.connectionName,
      isReplica: conn.connectionName.endsWith('_read_0'),
      notes: result.rows,
    }
  }

  async create(
    tenant: TenantModelContract<DemoMeta>,
    input: CreateNoteInput
  ): Promise<NoteRow> {
    // knex's bindings type rejects `null` literals; cast at the call site
    // because rawQuery passes them through to pg unchanged.
    const bindings = [input.title, input.body ?? null] as unknown as string[]
    const result = await tenant.getConnection().rawQuery(INSERT_NOTE_SQL, bindings)
    const row = result.rows[0] as NoteRow
    ;(await tenantLogger()).info({ noteId: row.id }, 'note created')
    return row
  }
}
