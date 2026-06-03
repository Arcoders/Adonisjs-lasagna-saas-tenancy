import { test } from '@japa/runner'
import ImpersonationService from '../../../src/services/impersonation_service.js'
import { setupTestConfig } from '../../helpers/config.js'
import { setConfig, getConfig } from '../../../src/config.js'

const SECRET = 'a'.repeat(64)

test.group('ImpersonationService — token signature & validation', (group) => {
  group.each.setup(() => {
    setupTestConfig()
    const cfg = getConfig()
    setConfig({ ...cfg, impersonation: { secret: SECRET } })
  })

  test('verify() rejects malformed tokens (empty, no dot, too short)', async ({ assert }) => {
    const svc = new ImpersonationService()
    assert.isNull(await svc.verify(''))
    assert.isNull(await svc.verify('only-session'))
    assert.isNull(await svc.verify('a.b'))
    assert.isNull(await svc.verify('.sig'))
    assert.isNull(await svc.verify('id.'))
  })

  test('verify() rejects tokens with bad signature', async ({ assert }) => {
    const svc = new ImpersonationService()
    const fake = 'deadbeefdeadbeefdeadbeefdeadbeef.' + '00'.repeat(32)
    assert.isNull(await svc.verify(fake))
  })

  test('start() throws when impersonation block is missing', async ({ assert }) => {
    setupTestConfig() // no impersonation block
    const svc = new ImpersonationService()
    await assert.rejects(
      () =>
        svc.start({
          tenantId: 't',
          targetUserId: 'u',
          adminId: 'a',
        }),
      /impersonation\.secret/
    )
  })

  test('start() throws when secret is shorter than 32 chars', async ({ assert }) => {
    const cfg = getConfig()
    setConfig({ ...cfg, impersonation: { secret: 'short' } })
    const svc = new ImpersonationService()
    await assert.rejects(
      () =>
        svc.start({
          tenantId: 't',
          targetUserId: 'u',
          adminId: 'a',
        }),
      /shorter than 32/
    )
  })
})
