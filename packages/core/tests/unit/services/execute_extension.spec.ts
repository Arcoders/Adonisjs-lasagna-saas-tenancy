import { test } from '@japa/runner'
import {
  executeExtension,
  ExtensionTimeoutError,
} from '../../../src/services/extensions/execute_extension.js'
import TooManyRequestsException from '../../../src/exceptions/too_many_requests_exception.js'
import RateLimitUnavailableException from '../../../src/exceptions/rate_limit_unavailable_exception.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Minimal ioredis-shaped pipeline doubles (mirrors the rate-limit middleware spec).
class CountingPipeline {
  constructor(private count: number) {}
  zremrangebyscore() {
    return this
  }
  zadd() {
    return this
  }
  zcard() {
    return this
  }
  expire() {
    return this
  }
  async exec() {
    return [
      [null, 0],
      [null, 0],
      [null, this.count],
      [null, 1],
    ]
  }
}
class FailingPipeline {
  zremrangebyscore() {
    return this
  }
  zadd() {
    return this
  }
  zcard() {
    return this
  }
  expire() {
    return this
  }
  async exec() {
    throw new Error('ECONNREFUSED — Redis is down')
  }
}
const redisWith = (pipeline: any) => async () => ({ pipeline: () => pipeline })

test.group('executeExtension — unguarded', () => {
  test('returns the function result when no guards are set', async ({ assert }) => {
    const out = await executeExtension(async () => 42, { label: 'x' })
    assert.equal(out, 42)
  })

  test('passes an AbortSignal to the function', async ({ assert }) => {
    let received: AbortSignal | undefined
    await executeExtension(
      async (signal) => {
        received = signal
        return 'ok'
      },
      { label: 'x' }
    )
    assert.instanceOf(received, AbortSignal)
    assert.isFalse(received!.aborted)
  })

  test('propagates the function rejection verbatim', async ({ assert }) => {
    await assert.rejects(
      () =>
        executeExtension(
          async () => {
            throw new Error('boom')
          },
          { label: 'x' }
        ),
      /boom/
    )
  })
})

test.group('executeExtension — timeout', () => {
  test('rejects with ExtensionTimeoutError when the deadline is exceeded', async ({ assert }) => {
    await assert.rejects(
      () =>
        executeExtension(() => delay(1000).then(() => 'late'), { label: 'slow', timeoutMs: 20 }),
      ExtensionTimeoutError
    )
  })

  test('aborts the signal when the deadline fires (cooperative cancellation)', async ({
    assert,
  }) => {
    let aborted = false
    await assert.rejects(
      () =>
        executeExtension(
          (signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                aborted = true
                reject(new Error('aborted by signal'))
              })
            }),
          { label: 'slow', timeoutMs: 20 }
        ),
      // The timeout rejection wins the race; the signal is still aborted.
      ExtensionTimeoutError
    )
    assert.isTrue(aborted, 'the timer must abort the controller so cooperative work can stop')
  })

  test('returns the value (and clears the timer) when the function finishes first', async ({
    assert,
  }) => {
    const out = await executeExtension(() => delay(5).then(() => 'fast'), {
      label: 'x',
      timeoutMs: 500,
    })
    assert.equal(out, 'fast')
  })
})

test.group('executeExtension — rate limit', () => {
  test('proceeds when the count is under the limit', async ({ assert }) => {
    const out = await executeExtension(async () => 'ran', {
      label: 'rpt',
      rateLimit: { limit: 10, windowSeconds: 60 },
      getRedis: redisWith(new CountingPipeline(3)),
    })
    assert.equal(out, 'ran')
  })

  test('throws TooManyRequests when the count exceeds the limit', async ({ assert }) => {
    let ran = false
    await assert.rejects(
      () =>
        executeExtension(
          async () => {
            ran = true
            return 'ran'
          },
          {
            label: 'rpt',
            rateLimit: { limit: 10, windowSeconds: 60 },
            getRedis: redisWith(new CountingPipeline(11)),
          }
        ),
      TooManyRequestsException
    )
    assert.isFalse(ran, 'must not run the extension once rate-limited')
  })

  test('fails CLOSED with 503 on a backend outage by default', async ({ assert }) => {
    await assert.rejects(
      () =>
        executeExtension(async () => 'ran', {
          label: 'rpt',
          rateLimit: { limit: 10, windowSeconds: 60 },
          getRedis: redisWith(new FailingPipeline()),
        }),
      RateLimitUnavailableException
    )
  })

  test('fails OPEN on a backend outage only when failOpen is set', async ({ assert }) => {
    const out = await executeExtension(async () => 'ran', {
      label: 'rpt',
      rateLimit: { limit: 10, windowSeconds: 60 },
      failOpen: true,
      getRedis: redisWith(new FailingPipeline()),
    })
    assert.equal(out, 'ran')
  })
})
