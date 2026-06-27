import { test } from '@japa/runner'
import { setConfig } from '../../../src/config.js'
import { testConfig } from '../../helpers/config.js'
import { TenantBaseModel } from '../../../src/models/base/tenant_base_model.js'
import { BackofficeBaseModel } from '../../../src/models/base/backoffice_base_model.js'
import { CentralBaseModel } from '../../../src/models/base/central_base_model.js'
import TenantAdapter from '../../../src/models/adapters/tenant_adapter.js'
import IsolationDriverRegistry from '../../../src/services/isolation/registry.js'
import { resolveIsolationKind } from '../../../src/models/base/isolation_kind.js'

/**
 * WS-5 / inheritance-base-model-lock-in.
 *
 * Isolation used to be implied purely by which base class a model extended and
 * which adapter the provider happened to attach to it. The declarative
 * `static isolation` marker makes the routing data-driven: one unified adapter
 * reads the marker. The three base classes become thin shims that just set it,
 * so a model can declare its isolation without being locked into a hierarchy.
 *
 * RED (pre-fix): the base classes had no `static isolation`; the
 * `resolveIsolationKind` helper module did not exist; the adapter never read it.
 */
test.group('declarative isolation — static isolation seam', (group) => {
  group.each.setup(() => setConfig({ ...testConfig }))

  test('each base model declares its isolation kind', ({ assert }) => {
    assert.equal((TenantBaseModel as any).isolation, 'tenant')
    assert.equal((BackofficeBaseModel as any).isolation, 'backoffice')
    assert.equal((CentralBaseModel as any).isolation, 'central')
  })

  test('resolveIsolationKind reads the marker and defaults to tenant', ({ assert }) => {
    assert.equal(resolveIsolationKind({ isolation: 'backoffice' } as any), 'backoffice')
    assert.equal(resolveIsolationKind({ isolation: 'central' } as any), 'central')
    assert.equal(resolveIsolationKind({} as any), 'tenant')
  })

  test('the unified adapter applies the backoffice schema for a backoffice-marked model', ({
    assert,
  }) => {
    let withSchemaArg: string | undefined
    const builder = {
      withSchema: (s: string) => {
        withSchemaArg = s
        return builder
      },
    }
    const client = { modelQuery: () => builder }
    const db = { connection: () => client }
    const adapter = new TenantAdapter(db as any, new IsolationDriverRegistry())
    const mc = { isolation: 'backoffice', connection: 'backoffice' } as any

    adapter.query(mc)

    assert.equal(withSchemaArg, testConfig.backofficeSchemaName)
  })

  test('the unified adapter does NOT schema-qualify a tenant-marked model', ({ assert }) => {
    let called = false
    const builder = {
      withSchema: () => {
        called = true
        return builder
      },
    }
    const client = { modelQuery: () => builder }
    const db = { connection: () => client }
    const adapter = new TenantAdapter(db as any, new IsolationDriverRegistry())
    // Explicit connection so this exercises only the query() schema branch, not
    // the tenant driver-routing path in modelConstructorClient.
    const mc = { isolation: 'tenant', connection: 'public' } as any

    adapter.query(mc)

    assert.isFalse(called)
  })
})
