import type { IsolationDriver } from '@adonisjs-lasagna/saas-tenancy/services'

type DbService = any
type QueryClient = any

export type Ref = { id: string; name: string }

/**
 * Resolve a query client for a tenant, driver-aware. For schema-pg/database-pg
 * this asks the driver for the tenant's own connection; for rowscope-pg every
 * tenant shares the central `tenant` connection and is separated by tenant_id.
 */
export async function clientFor(
  driver: IsolationDriver,
  db: DbService,
  ref: Ref
): Promise<QueryClient> {
  if (driver.name === 'rowscope-pg') return db.connection('tenant')
  return driver.connect(ref as any)
}

const isRowScope = (driver: IsolationDriver) => driver.name === 'rowscope-pg'

export function selectById(conn: QueryClient, driver: IsolationDriver, ref: Ref, id: number) {
  const q = conn.from('notes').where('id', id)
  if (isRowScope(driver)) q.where('tenant_id', ref.id)
  return q.first()
}

export function insertNote(conn: QueryClient, driver: IsolationDriver, ref: Ref) {
  const row: Record<string, unknown> = { title: 'churn', body: 'b' }
  if (isRowScope(driver)) row.tenant_id = ref.id
  return conn.table('notes').insert(row)
}

export function selfJoin(conn: QueryClient, driver: IsolationDriver, ref: Ref) {
  const q = conn
    .from('notes as a')
    .innerJoin('notes as b', 'a.id', 'b.id')
    .select('a.id')
    .orderBy('a.id', 'asc')
    .limit(20)
  if (isRowScope(driver)) q.where('a.tenant_id', ref.id).where('b.tenant_id', ref.id)
  return q
}

export function selectMarker(conn: QueryClient, driver: IsolationDriver, ref: Ref) {
  const q = conn.from('notes').whereLike('title', 'marker:%').select('title')
  if (isRowScope(driver)) q.where('tenant_id', ref.id)
  return q
}

export function firstId(conn: QueryClient, driver: IsolationDriver, ref: Ref) {
  const q = conn.from('notes').select('id').orderBy('id', 'asc')
  if (isRowScope(driver)) q.where('tenant_id', ref.id)
  return q.first()
}
