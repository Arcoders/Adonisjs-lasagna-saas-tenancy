import { test } from '@japa/runner'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SqlImportService, {
  rewriteSchemaPreservingCopyData,
} from '../../src/services/sql_import_service.js'

/**
 * Dry-run unit coverage: the parse/rewrite/count path runs entirely in-process
 * (no DB, no psql), so it's a fast unit check of statement splitting, COPY
 * detection, skip-pattern handling, and schema rewriting.
 */
test.group('SqlImportService.import — dry-run', (group) => {
  let dir: string

  group.each.setup(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sqlimport-test-'))
  })
  group.each.teardown(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeDump(sql: string): Promise<string> {
    const file = join(dir, 'dump.sql')
    await writeFile(file, sql, 'utf-8')
    return file
  }

  test('counts statements, skips meta-commands, and detects COPY blocks', async ({ assert }) => {
    const sql = [
      'SET search_path TO public;',
      'CREATE TABLE "public"."notes" (id serial primary key, body text);',
      "INSERT INTO public.notes (body) VALUES ('a');",
      'COPY public.notes (id, body) FROM stdin;',
      '1\thello',
      '2\tworld',
      '\\.',
      'INSERT INTO "public"."notes" (body) VALUES (\'b\');',
    ].join('\n')

    const file = await writeDump(sql)
    const svc = new SqlImportService()
    const tenant = { id: 't', schemaName: 'tenant_abc' } as any

    const result = await svc.import(tenant, file, { sourceSchema: 'public', dryRun: true })

    assert.equal(result.mode, 'dry-run')
    assert.equal(result.copyBlocksExecuted, 1, 'one COPY block detected')
    assert.equal(result.copyRowsImported, 2, 'two COPY data rows')
    assert.isAbove(result.statementsSkipped, 0, 'SET search_path is skipped')
    assert.isAbove(result.statementsExecuted, 0, 'real DDL/DML counted as executable')
    assert.isEmpty(result.errors)
  })

  test('a dump with no COPY blocks reports zero copy work', async ({ assert }) => {
    const sql = [
      'CREATE TABLE "public"."t" (id int);',
      'INSERT INTO public.t (id) VALUES (1);',
    ].join('\n')
    const file = await writeDump(sql)
    const svc = new SqlImportService()
    const tenant = { id: 't', schemaName: 'tenant_xyz' } as any

    const result = await svc.import(tenant, file, { sourceSchema: 'public', dryRun: true })
    assert.equal(result.copyBlocksExecuted, 0)
    assert.equal(result.copyRowsImported, 0)
    assert.equal(result.mode, 'dry-run')
  })

  test('rejects a missing dump file', async ({ assert }) => {
    const svc = new SqlImportService()
    const tenant = { id: 't', schemaName: 'tenant_xyz' } as any
    await assert.rejects(() =>
      svc.import(tenant, join(dir, 'does-not-exist.sql'), { sourceSchema: 'public', dryRun: true })
    )
  })
})

test.group('rewriteSchemaPreservingCopyData', () => {
  test('rewrites schema-qualified identifiers and the COPY header', ({ assert }) => {
    const sql = [
      'CREATE TABLE "public"."notes" (id int);',
      'INSERT INTO public.notes (id) VALUES (1);',
      'COPY public.notes (id, body) FROM stdin;',
    ].join('\n')

    const out = rewriteSchemaPreservingCopyData(sql, 'public', 'tenant_abc')

    assert.include(out, '"tenant_abc"."notes"')
    assert.include(out, 'INSERT INTO "tenant_abc".notes')
    assert.include(out, 'COPY "tenant_abc".notes (id, body) FROM stdin;')
    assert.notInclude(out, 'public.')
  })

  test('does NOT rewrite a `public.` value inside COPY data rows', ({ assert }) => {
    const sql = [
      'COPY public.notes (id, body) FROM stdin;',
      '1\tpublic.foo is a literal value',
      '2\tsee public.bar in the docs',
      '\\.',
      'INSERT INTO public.notes (id) VALUES (3);',
    ].join('\n')

    const out = rewriteSchemaPreservingCopyData(sql, 'public', 'tenant_abc')
    const lines = out.split('\n')

    // Header rewritten…
    assert.include(lines[0], 'COPY "tenant_abc".notes')
    // …but the data rows are preserved byte-for-byte (no corruption).
    assert.equal(lines[1], '1\tpublic.foo is a literal value')
    assert.equal(lines[2], '2\tsee public.bar in the docs')
    assert.equal(lines[3], '\\.')
    // …and statements after the block resume rewriting.
    assert.include(lines[4], 'INSERT INTO "tenant_abc".notes')
  })
})
