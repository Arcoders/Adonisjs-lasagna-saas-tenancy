import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-2 / doctor-and-metrics-load-all-tenants (anti-regression lock).
 *
 * The ops paths that walk EVERY tenant — `tenant:doctor` and `tenant:queue:stats`
 * — must cursor-iterate via `repo.each()` (keyset pagination), never load the
 * whole table with `repo.all(`. The `/metrics` collector is exempt: it uses the
 * `countByStatus` aggregate and only falls back to `all()` when the repo omits
 * that optional method, so it is intentionally not scanned here.
 *
 * RED (pre-fix): both files called `repo.all(`.
 */
const FILES = {
  doctor: fileURLToPath(new URL('../../src/services/doctor/doctor_service.ts', import.meta.url)),
  queueStats: fileURLToPath(new URL('../../src/commands/tenant_queue_stats.ts', import.meta.url)),
}

const ALL_RE = /repo\.all\(/

test.group('architectural — ops paths do not load all tenants', () => {
  test('doctor_service iterates via each(), not all()', ({ assert }) => {
    const src = readFileSync(FILES.doctor, 'utf8')
    assert.notMatch(src, ALL_RE, 'DoctorService must use repo.each(), not repo.all(')
    assert.match(src, /repo\.each\(/, 'DoctorService must cursor-iterate via repo.each(')
  })

  test('tenant:queue:stats iterates via each(), not all()', ({ assert }) => {
    const src = readFileSync(FILES.queueStats, 'utf8')
    assert.notMatch(src, ALL_RE, 'queue:stats must use repo.each(), not repo.all(')
    assert.match(src, /repo\.each\(/, 'queue:stats must cursor-iterate via repo.each(')
  })

  test('detector controls: the matcher is not vacuously true', ({ assert }) => {
    assert.match('const x = await repo.all({})', ALL_RE)
    assert.notMatch('const x = await repo.each(cb)', ALL_RE)
  })
})
