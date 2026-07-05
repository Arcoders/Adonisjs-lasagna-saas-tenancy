import { test } from '@japa/runner'
// The I1 guard is a repo-root script (it runs in `npm run check`); import its
// pure auditor to exercise the placement rules that keep embeddings physically
// tenant-scoped (never a global public.embeddings, never a hardcoded tenant_<id>).
import { auditVectorPlacement } from '../../../../../scripts/check-ai-invariant-1.mjs'

test.group('architectural — I1 vector placement guard', () => {
  test('clean, driver-placed SQL passes', ({ assert }) => {
    const problems = auditVectorPlacement([
      {
        path: 'src/services/vector_store_service.ts',
        source:
          'const table = AI_EMBEDDINGS_TABLE\nawait client.rawQuery(`SELECT count(*) FROM ${table}`)',
      },
    ])
    assert.deepEqual(problems, [])
  })

  test('a global public.embeddings table is an I1 violation', ({ assert }) => {
    const problems = auditVectorPlacement([
      { path: 'src/x.ts', source: 'await db.rawQuery(`SELECT * FROM public.embeddings`)' },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /global embeddings table/)
  })

  test('a hardcoded tenant_${id} schema is an I1 violation', ({ assert }) => {
    const problems = auditVectorPlacement([
      { path: 'src/x.ts', source: 'const t = `tenant_${tenantId}.embeddings`' },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /hardcoded tenant_<id> schema/)
  })

  test("a 'tenant_' + id concatenation is an I1 violation", ({ assert }) => {
    const problems = auditVectorPlacement([
      { path: 'src/x.ts', source: "const schema = 'tenant_' + tenantId" },
    ])
    assert.lengthOf(problems, 1)
  })

  test('a comment naming the forbidden patterns is not flagged', ({ assert }) => {
    const problems = auditVectorPlacement([
      {
        path: 'src/x.ts',
        source: '// never a global public.embeddings, never a tenant_${id} schema',
      },
    ])
    assert.deepEqual(problems, [])
  })
})
