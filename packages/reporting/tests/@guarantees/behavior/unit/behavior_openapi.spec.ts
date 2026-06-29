import { test } from '@japa/runner'
import { getReportingOpenAPISpec, listReportingSpecPaths } from '../../../../src/openapi.js'

test.group('getReportingOpenAPISpec', () => {
  test('documents the dashboard with its query params and 200/400 responses', ({ assert }) => {
    const spec = getReportingOpenAPISpec('/reporting')
    const dash = spec.paths['/reporting/dashboard']?.get as any
    assert.exists(dash)
    const paramNames = dash.parameters.map((p: any) => p.name)
    assert.deepEqual(paramNames.sort(), ['limit', 'period', 'since', 'until'])
    assert.exists(dash.responses['200'])
    assert.exists(dash.responses['400'])
  })

  test('documents the extension endpoint with a 404', ({ assert }) => {
    const spec = getReportingOpenAPISpec('/reporting')
    const ext = spec.paths['/reporting/reports/extension/{name}']?.get as any
    assert.exists(ext)
    assert.exists(ext.responses['404'])
  })

  test('re-paths every route when the prefix changes (no hard-coded /reporting)', ({ assert }) => {
    const paths = listReportingSpecPaths('/admin/usage')
    assert.isAbove(paths.length, 0)
    for (const p of paths) {
      assert.isTrue(p.startsWith('/admin/usage'), `path ${p} not under the custom prefix`)
    }
    assert.include(paths, '/admin/usage/dashboard')
  })

  test('is a valid 3.1.0 document shell', ({ assert }) => {
    const spec = getReportingOpenAPISpec()
    assert.equal(spec.openapi, '3.1.0')
    assert.exists(spec.info.title)
    assert.exists(spec.components.schemas.Dashboard)
  })
})
