import { test } from '@japa/runner'
// The drift guard is a repo-root script; import its pure auditor to exercise the
// logic that keeps the AI package's per-tenant migration from silently failing
// to compile (tsconfig include drops -> no build/tenant_migrations -> tenant
// boots with no embeddings table, with NO error).
import { auditManifestMigrations } from '../../../../../scripts/check-satellite-migrations.mjs'

const tsconfig = {
  compilerOptions: { outDir: './build', rootDir: './' },
  include: ['src/**/*.ts', 'providers/**/*.ts', 'tenant_migrations/**/*.ts', 'configure.ts'],
}
const listOne = () => ['1751414400000_create_ai_embeddings_table.ts']

test.group('architectural: per-tenant migration wiring guard', () => {
  test('passes when include covers the source dir and a migration exists', ({ assert }) => {
    const problems = auditManifestMigrations('ai', 'build/tenant_migrations', tsconfig, listOne)
    assert.deepEqual(problems, [])
  })

  test('trips when tsconfig include omits the migration dir (the silent-drift bug)', ({
    assert,
  }) => {
    const dropped = { ...tsconfig, include: ['src/**/*.ts', 'providers/**/*.ts', 'configure.ts'] }
    const problems = auditManifestMigrations('ai', 'build/tenant_migrations', dropped, listOne)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /does not cover "tenant_migrations"/)
  })

  test('trips when the source dir is missing entirely', ({ assert }) => {
    const problems = auditManifestMigrations('ai', 'build/tenant_migrations', tsconfig, () => null)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /source dir "tenant_migrations" is missing/)
  })

  test('trips when the source dir holds no .ts migration', ({ assert }) => {
    const problems = auditManifestMigrations('ai', 'build/tenant_migrations', tsconfig, () => [])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /holds no .ts migration/)
  })

  test('trips when the declared output is not under the tsconfig outDir', ({ assert }) => {
    const problems = auditManifestMigrations('ai', 'dist/tenant_migrations', tsconfig, listOne)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /not under the tsconfig outDir/)
  })
})
