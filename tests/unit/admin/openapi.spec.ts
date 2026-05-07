import { test } from '@japa/runner'
import { getOpenAPISpec, listSpecPaths } from '../../../src/admin/openapi.js'

test.group('OpenAPI spec', () => {
  test('declares OpenAPI 3.1 with title and version', ({ assert }) => {
    const spec = getOpenAPISpec()
    assert.equal(spec.openapi, '3.1.0')
    assert.equal(spec.info.title, 'Lasagna Multitenancy Admin API')
    assert.equal(spec.info.version, '2.0.0')
  })

  test('paths use the configured prefix', ({ assert }) => {
    const spec = getOpenAPISpec('/foo/bar')
    const keys = Object.keys(spec.paths)
    assert.isTrue(keys.length > 0)
    assert.isTrue(keys.every((p) => p.startsWith('/foo/bar/')))
  })

  test('strips trailing slash on prefix', ({ assert }) => {
    const a = listSpecPaths('/admin')
    const b = listSpecPaths('/admin/')
    assert.deepEqual(a.sort(), b.sort())
  })

  test('every component schema referenced is also declared', ({ assert }) => {
    const spec = getOpenAPISpec()
    const declared = new Set(Object.keys(spec.components.schemas))
    const referenced = new Set<string>()

    const collect = (node: any): void => {
      if (!node || typeof node !== 'object') return
      if (typeof node.$ref === 'string') {
        const m = node.$ref.match(/^#\/components\/schemas\/(.+)$/)
        if (m) referenced.add(m[1])
      }
      for (const v of Object.values(node)) collect(v)
    }
    collect(spec.paths)
    collect(spec.components.schemas)

    const missing = [...referenced].filter((r) => !declared.has(r))
    assert.deepEqual(missing, [], `undeclared schemas: ${missing.join(', ')}`)
  })

  test('covers every satellite resource at least once', ({ assert }) => {
    const paths = listSpecPaths('/admin/multitenancy')
    const must = [
      '/admin/multitenancy/tenants',
      '/admin/multitenancy/tenants/{id}/audit-logs',
      '/admin/multitenancy/tenants/{id}/webhooks',
      '/admin/multitenancy/tenants/{id}/feature-flags',
      '/admin/multitenancy/tenants/{id}/branding',
      '/admin/multitenancy/tenants/{id}/sso',
      '/admin/multitenancy/tenants/{id}/metrics',
      '/admin/multitenancy/tenants/{id}/quotas',
      '/admin/multitenancy/health/report',
      '/admin/multitenancy/openapi.json',
      '/admin/multitenancy/docs',
    ]
    for (const p of must) {
      assert.include(paths, p, `expected spec to include ${p}`)
    }
  })
})
