import { randomUUID } from 'node:crypto'

/**
 * Shared in-memory doubles for the webhook delivery specs
 * (`webhook_service`, `webhook_ssrf_service_level`,
 * `webhook_secret_generation`). One definition keeps the hook/delivery
 * contract the suites exercise from drifting between files.
 */
export function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    event: 'user.created',
    payload: { userId: '123' },
    status: 'pending' as const,
    attempt: 1,
    statusCode: null as number | null,
    responseBody: null as string | null,
    nextRetryAt: null as unknown,
    save: async () => {},
    ...overrides,
  }
}

export function makeHook(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    url: 'https://example.com/webhook',
    events: ['user.created'],
    secret: null as string | null,
    enabled: true,
    ...overrides,
  }
}
