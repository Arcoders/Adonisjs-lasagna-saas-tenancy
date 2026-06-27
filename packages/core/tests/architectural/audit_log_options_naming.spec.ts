import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-7 / auditlog-log-vs-logactionoptions-naming.
 *
 * `AuditLogService.log()` took a `LogActionOptions`, a name that says "action"
 * for a method called "log". The canonical type is `LogOptions`; the old name
 * survives only as a `@deprecated` alias so existing imports still resolve.
 *
 * RED (pre-fix): `LogActionOptions` was the exported interface; no `LogOptions`.
 */
const SVC = fileURLToPath(new URL('../../src/services/audit_log_service.ts', import.meta.url))

test.group('architectural — audit log options naming', () => {
  test('LogOptions is canonical; LogActionOptions is a deprecated alias', ({ assert }) => {
    const src = readFileSync(SVC, 'utf8')
    assert.match(src, /export interface LogOptions\b/, 'LogOptions must be the exported interface')
    assert.match(
      src,
      /export type LogActionOptions = LogOptions/,
      'LogActionOptions must alias LogOptions'
    )
    assert.match(src, /@deprecated/, 'the old name must carry a @deprecated tag')
    assert.notMatch(
      src,
      /export interface LogActionOptions\b/,
      'LogActionOptions must no longer be an interface'
    )
  })

  test('log() accepts LogOptions', ({ assert }) => {
    const src = readFileSync(SVC, 'utf8')
    assert.match(src, /log\(options: LogOptions\)/)
  })
})
