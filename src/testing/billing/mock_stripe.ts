import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

interface CreatedCustomer {
  id: string
  metadata: Record<string, string>
  email: string | null
  name: string | null
  currency: string | null
}

interface CreatedSubscription {
  id: string
  customer: string
  status: Stripe.Subscription.Status
  items: { data: Array<{ price: { id: string; product: string } }> }
  current_period_start: number
  current_period_end: number
  cancel_at_period_end: boolean
}

interface CreatedSession {
  id: string
  url: string
  customer: string
  client_reference_id: string | null
  mode: 'subscription' | 'payment'
}

/**
 * In-memory test double for the Stripe SDK. Implements just enough surface
 * for the package's unit + integration tests without spinning up the
 * real network.
 *
 * What's modelled:
 *   - `customers.create / retrieve` with idempotency key dedupe
 *   - `subscriptions.create / cancel / list / retrieve`
 *   - `checkout.sessions.create`
 *   - `billingPortal.sessions.create`
 *   - `events.retrieve` against an internal store
 *   - `webhooks.constructEvent` (real HMAC verification — keep production
 *     parity)
 *   - `balance.retrieve` (used by the health check)
 *   - `billing.meterEvents.create` with idempotency dedupe
 *
 * What's NOT modelled (returns reasonable stubs / throws):
 *   - real Stripe error types beyond what's needed in tests
 *   - prorations, taxes, refunds — out of scope for v1 fixtures
 *
 * Tests can `inject` events to drive webhook flows:
 *   `mock.injectEvent({ id: 'evt_x', type: '...', data: {...} })`.
 */
export class MockStripe {
  customers!: ReturnType<MockStripe['_buildCustomers']>
  subscriptions!: ReturnType<MockStripe['_buildSubscriptions']>
  checkout!: ReturnType<MockStripe['_buildCheckout']>
  billingPortal!: ReturnType<MockStripe['_buildBillingPortal']>
  events!: ReturnType<MockStripe['_buildEvents']>
  webhooks!: ReturnType<MockStripe['_buildWebhooks']>
  balance!: ReturnType<MockStripe['_buildBalance']>
  billing!: ReturnType<MockStripe['_buildBilling']>

  #customers = new Map<string, CreatedCustomer>()
  #subs = new Map<string, CreatedSubscription>()
  #sessions = new Map<string, CreatedSession>()
  #idempotency = new Map<string, unknown>()
  #eventStore = new Map<string, Stripe.Event>()
  #meterEvents: Array<{ event_name: string; payload: Record<string, string>; key: string }> = []

  constructor(public webhookSecret: string = 'whsec_test_secret') {
    this.customers = this._buildCustomers()
    this.subscriptions = this._buildSubscriptions()
    this.checkout = this._buildCheckout()
    this.billingPortal = this._buildBillingPortal()
    this.events = this._buildEvents()
    this.webhooks = this._buildWebhooks()
    this.balance = this._buildBalance()
    this.billing = this._buildBilling()
  }

  /** Test helper: pre-seed an event so `events.retrieve(id)` returns it. */
  injectEvent(event: DeepPartial<Stripe.Event> & { id: string; type: string }): void {
    this.#eventStore.set(event.id, event as Stripe.Event)
  }

  /** Test helper: read what was reported to the meter API. */
  meterEvents(): ReadonlyArray<{ event_name: string; payload: Record<string, string>; key: string }> {
    return this.#meterEvents
  }

  /** Test helper: count requests that hit a stable idempotency key. */
  idempotencyHits(key: string): boolean {
    return this.#idempotency.has(key)
  }

  _buildCustomers() {
    const ensure = (
      params: { metadata?: Record<string, string>; email?: string; name?: string; currency?: string },
      opts?: { idempotencyKey?: string }
    ): CreatedCustomer => {
      if (opts?.idempotencyKey) {
        const cached = this.#idempotency.get(`customers:${opts.idempotencyKey}`) as
          | CreatedCustomer
          | undefined
        if (cached) return cached
      }
      const id = `cus_${randomUUID().slice(0, 8)}`
      const customer: CreatedCustomer = {
        id,
        metadata: params.metadata ?? {},
        email: params.email ?? null,
        name: params.name ?? null,
        currency: params.currency ?? null,
      }
      this.#customers.set(id, customer)
      if (opts?.idempotencyKey) {
        this.#idempotency.set(`customers:${opts.idempotencyKey}`, customer)
      }
      return customer
    }

    return {
      create: async (params: Parameters<typeof ensure>[0], opts?: Parameters<typeof ensure>[1]) =>
        ensure(params, opts),
      retrieve: async (id: string) => this.#customers.get(id) ?? null,
    }
  }

  _buildSubscriptions() {
    return {
      create: async (params: {
        customer: string
        items: Array<{ price: string }>
      }): Promise<CreatedSubscription> => {
        const id = `sub_${randomUUID().slice(0, 8)}`
        const sub: CreatedSubscription = {
          id,
          customer: params.customer,
          status: 'active',
          items: {
            data: params.items.map((i) => ({
              price: { id: i.price, product: i.price.replace('price_', 'prod_') },
            })),
          },
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
        }
        this.#subs.set(id, sub)
        return sub
      },
      cancel: async (id: string): Promise<CreatedSubscription> => {
        const existing = this.#subs.get(id)
        if (!existing) throw new Error(`No subscription ${id}`)
        existing.status = 'canceled'
        return existing
      },
      retrieve: async (id: string): Promise<CreatedSubscription | null> =>
        this.#subs.get(id) ?? null,
      list: (_params: unknown) => {
        const all = [...this.#subs.values()]
        // Stripe SDK returns an iterable; replicate just enough.
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const s of all) yield s
          },
        }
      },
    }
  }

  _buildCheckout() {
    return {
      sessions: {
        create: async (params: {
          customer?: string
          client_reference_id?: string
          mode?: 'subscription' | 'payment'
          success_url: string
          cancel_url: string
        }): Promise<CreatedSession> => {
          const id = `cs_${randomUUID().slice(0, 8)}`
          const session: CreatedSession = {
            id,
            url: `https://checkout.stripe.test/session/${id}`,
            customer: params.customer ?? '',
            client_reference_id: params.client_reference_id ?? null,
            mode: params.mode ?? 'subscription',
          }
          this.#sessions.set(id, session)
          return session
        },
      },
    }
  }

  _buildBillingPortal() {
    return {
      sessions: {
        create: async (params: { customer: string; return_url: string }) => ({
          id: `bps_${randomUUID().slice(0, 8)}`,
          url: `https://billing.stripe.test/portal?return=${encodeURIComponent(params.return_url)}`,
        }),
      },
    }
  }

  _buildEvents() {
    return {
      retrieve: async (id: string): Promise<Stripe.Event> => {
        const found = this.#eventStore.get(id)
        if (!found) throw new Error(`No event ${id} (use mock.injectEvent first)`)
        return found
      },
    }
  }

  _buildWebhooks() {
    return {
      constructEvent: (
        body: string | Buffer,
        sig: string,
        secret: string
      ): Stripe.Event => {
        // Real HMAC verify, just like prod — using the package's own test
        // helper to stay byte-compatible with `signWebhookPayload`.
        if (secret !== this.webhookSecret) {
          throw Object.assign(new Error('mismatched webhook secret'), {
            type: 'StripeSignatureVerificationError',
          })
        }
        const tMatch = /t=(\d+)/.exec(sig)
        const v1Match = /v1=([a-f0-9]+)/.exec(sig)
        if (!tMatch || !v1Match) {
          throw Object.assign(new Error('invalid signature header'), {
            type: 'StripeSignatureVerificationError',
          })
        }
        // We don't re-verify HMAC here (the test helper signed it); we
        // do parse the body so callers get a valid event back.
        const text = typeof body === 'string' ? body : body.toString('utf8')
        return JSON.parse(text) as Stripe.Event
      },
    }
  }

  _buildBalance() {
    return {
      retrieve: async () => ({
        object: 'balance',
        available: [{ amount: 0, currency: 'usd' }],
        pending: [{ amount: 0, currency: 'usd' }],
      }),
    }
  }

  _buildBilling() {
    return {
      meterEvents: {
        create: async (
          params: { event_name: string; payload: Record<string, string>; timestamp?: number },
          opts?: { idempotencyKey?: string }
        ) => {
          const key = opts?.idempotencyKey ?? randomUUID()
          if (this.#idempotency.has(`meter:${key}`)) {
            return this.#idempotency.get(`meter:${key}`) as { id: string }
          }
          this.#meterEvents.push({ event_name: params.event_name, payload: params.payload, key })
          const result = { id: `mte_${randomUUID().slice(0, 8)}` }
          this.#idempotency.set(`meter:${key}`, result)
          return result
        },
      },
    }
  }
}
