import { test } from '@japa/runner'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import type { HttpContext } from '@adonisjs/core/http'
import Tenant from '#app/models/backoffice/tenant'
import {
  authorizeFleetTool,
  countBookings,
  listAvailableVehicles,
  revenueSummary,
  topRentedVehicles,
} from '#app/ai/fleet_tools'

/**
 * The fleet assistant's read-only tools (WS-AI-11), against the real seeded
 * schemas.
 *
 * These drive the handlers the way the satellite's executor does — inside
 * `tenancy.run(tenant)` — so the queries are exercised against the actual tables
 * rather than a double. That is the point: the satellite's own suite proves the
 * loop, the gate and the executor; what it cannot prove is that THIS app's Lucid
 * queries are right and that a tool reads only the company that asked.
 */

const company = (slug: string) =>
  Tenant.query().where('custom_domain', `${slug}.localhost`).firstOrFail()

/** A staff member, as the auth guards present one to `authorizeTool`. */
function ctxAs(staff: { role: string } | null): HttpContext {
  return {
    auth: { use: (name: string) => (name === 'web-tenant' ? { user: staff ?? undefined } : {}) },
  } as unknown as HttpContext
}

test.group('AI fleet tools — live tenant data', () => {
  test('count_bookings totals the company and breaks down by status', async ({ assert }) => {
    const acme = await company('acme')
    const result = (await tenancy.run(acme, () => countBookings.handler({}))) as {
      total: number
      byStatus: Record<string, number>
    }

    assert.isAtLeast(result.total, 1, 'the seeded company has bookings')
    // The breakdown must account for every booking, or the assistant would state a
    // total it cannot justify.
    const summed = Object.values(result.byStatus).reduce((a, b) => a + b, 0)
    assert.equal(summed, result.total)
    for (const count of Object.values(result.byStatus)) assert.isNumber(count)
  })

  test('count_bookings narrows to a single status', async ({ assert }) => {
    const acme = await company('acme')
    const all = (await tenancy.run(acme, () => countBookings.handler({}))) as {
      byStatus: Record<string, number>
    }
    const confirmed = (await tenancy.run(acme, () =>
      countBookings.handler({ status: 'confirmed' })
    )) as { status: string; count: number }

    assert.equal(confirmed.status, 'confirmed')
    assert.equal(confirmed.count, all.byStatus.confirmed, 'the filter agrees with the breakdown')
  })

  test('list_available_vehicles returns the fleet free for a window', async ({ assert }) => {
    const acme = await company('acme')
    const result = (await tenancy.run(acme, () =>
      listAvailableVehicles.handler({ from: '2030-01-10', to: '2030-01-12' })
    )) as { available: number; vehicles: { plate: string }[] }

    // A window far in the future collides with no seeded booking, so availability
    // is the whole in-service fleet.
    assert.isAtLeast(result.available, 1)
    assert.equal(result.available, result.vehicles.length)
    assert.exists(result.vehicles[0]!.plate)
  })

  test('list_available_vehicles tells the model when its dates are unusable', async ({
    assert,
  }) => {
    // Returned, not thrown: a generic tool_execution_failed teaches the model
    // nothing, while a named error lets it retry with a real date in the same loop.
    const acme = await company('acme')
    const bad = (await tenancy.run(acme, () =>
      listAvailableVehicles.handler({ from: 'next tuesday', to: 'whenever' })
    )) as { error: string }
    assert.equal(bad.error, 'invalid_date')

    const backwards = (await tenancy.run(acme, () =>
      listAvailableVehicles.handler({ from: '2030-01-12', to: '2030-01-10' })
    )) as { error: string }
    assert.equal(backwards.error, 'empty_window')
  })

  test('revenue_summary totals real rentals in major units', async ({ assert }) => {
    const acme = await company('acme')
    const ytd = (await tenancy.run(acme, () =>
      revenueSummary.handler({ period: 'year_to_date' })
    )) as { period: string; amount: number; currency: string }

    assert.equal(ytd.period, 'year_to_date')
    assert.isNumber(ytd.amount)
    assert.isFalse(Number.isNaN(ytd.amount), 'a NaN would be stated to the user as a number')
    assert.exists(ytd.currency)
  })

  test('top_rented_vehicles ranks and honours its limit', async ({ assert }) => {
    const acme = await company('acme')
    const result = (await tenancy.run(acme, () => topRentedVehicles.handler({ limit: 2 }))) as {
      ranked: { vehicle: string; rentals: number }[]
    }

    assert.isAtMost(result.ranked.length, 2)
    if (result.ranked.length === 2) {
      assert.isAtLeast(result.ranked[0]!.rentals, result.ranked[1]!.rentals, 'ranked most first')
    }
    if (result.ranked.length > 0) {
      // Resolved to a human label, not a bare uuid the assistant would read aloud.
      assert.notMatch(result.ranked[0]!.vehicle, /^[0-9a-f-]{36}$/i)
    }
  })
})

test.group('AI fleet tools — isolation', () => {
  test('a tool reads only the company it runs under', async ({ assert }) => {
    const [acme, sahara] = await Promise.all([company('acme'), company('sahara-cars')])
    const window = { from: '2030-01-10', to: '2030-01-12' }

    const acmeFleet = (await tenancy.run(acme, () => listAvailableVehicles.handler(window))) as {
      vehicles: { plate: string }[]
    }
    const saharaFleet = (await tenancy.run(sahara, () =>
      listAvailableVehicles.handler(window)
    )) as { vehicles: { plate: string }[] }

    const acmePlates = acmeFleet.vehicles.map((v) => v.plate)
    const saharaPlates = saharaFleet.vehicles.map((v) => v.plate)
    assert.isAtLeast(acmePlates.length, 1)
    assert.isAtLeast(saharaPlates.length, 1)
    // Physically separate schemas: the same tool, run under two companies, must
    // never surface one company's plate to the other.
    const overlap = acmePlates.filter((p) => saharaPlates.includes(p))
    assert.lengthOf(overlap, 0)
  })
})

test.group('AI fleet tools — authorizeTool', () => {
  test('the owner may read everything', async ({ assert }) => {
    const acme = await company('acme')
    const ctx = ctxAs({ role: 'owner' })
    for (const tool of ['count_bookings', 'revenue_summary', 'top_rented_vehicles']) {
      assert.deepEqual(authorizeFleetTool(ctx, acme, tool), { kind: 'allow' })
    }
  })

  test('an agent runs the counter but is not shown the takings', async ({ assert }) => {
    const acme = await company('acme')
    const ctx = ctxAs({ role: 'agent' })
    assert.deepEqual(authorizeFleetTool(ctx, acme, 'count_bookings'), { kind: 'allow' })
    assert.deepEqual(authorizeFleetTool(ctx, acme, 'list_available_vehicles'), { kind: 'allow' })
    assert.deepEqual(authorizeFleetTool(ctx, acme, 'revenue_summary'), { kind: 'deny' })
  })

  test('an unresolvable staff member is denied (fail-closed)', async ({ assert }) => {
    const acme = await company('acme')
    assert.deepEqual(authorizeFleetTool(ctxAs(null), acme, 'count_bookings'), { kind: 'deny' })
    // An unknown role is not a known role: it denies rather than falling through.
    assert.deepEqual(authorizeFleetTool(ctxAs({ role: 'intern' }), acme, 'count_bookings'), {
      kind: 'deny',
    })
  })
})
