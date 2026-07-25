import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { DateTime } from 'luxon'
import type { BookingStatus } from '#app/models/tenant_scoped/booking'
import type { VehicleStatus } from '#app/models/tenant_scoped/vehicle'

/**
 * The fleet assistant's read-only tools (WS-AI-11).
 *
 * The AI satellite is a RAG-over-documents gateway: on its own it answers "what is
 * our fuel policy?" from the knowledge base but cannot answer "how many bookings do
 * I have?", which needs a query against this company's own tables. The old
 * `/assistant/context` snapshot folded fixed aggregates into every turn — it answered
 * "how many / how much" but never a drill-down. These tools replace it outright: the
 * model chooses what to look up, with arguments, per question, and the snapshot is
 * gone.
 *
 * Every handler is a plain Lucid query on a `TenantBaseModel`, which the adapter
 * already routes to the resolved company's schema — and the satellite's executor
 * runs it inside `tenancy.run(tenant)` and re-asserts the scope first, so a tool can
 * only ever read the company that asked. Models are imported INSIDE the handlers:
 * this module is reached from `config/multitenancy.ts`, which loads before the
 * provider boots, and a top-level model import would pull the base models in too
 * early (the same reason the `compliance.anonymize` hook imports dynamically).
 *
 * All of them are `mode: 'read'`. Nothing here mutates, so none needs the action
 * kill-switch or a confirmation round-trip.
 *
 * Arguments are validated by the satellite's shipped JSON-Schema subset checker via
 * each tool's `inputSchema`, NOT by a host `parseInput`. Two reasons: the checker's
 * whitelist reconstruction is stricter (it rebuilds the object from the declared
 * properties, so an undeclared or prototype-polluting key cannot reach the handler
 * at all), and `parseInput` is synchronous while vine validates asynchronously, so
 * vine cannot satisfy that seam anyway. These inputs — an enum, two date strings, a
 * bounded integer — are fully expressible in the subset.
 */

const BOOKING_STATUSES: BookingStatus[] = [
  'quote',
  'confirmed',
  'active',
  'completed',
  'cancelled',
  'no_show',
]

/** Statuses that represent a real rental (a quote / cancellation / no-show is not one). */
const RENTAL_STATUSES: BookingStatus[] = ['confirmed', 'active', 'completed']

const VEHICLE_STATUSES: VehicleStatus[] = ['available', 'rented', 'maintenance', 'retired']

/** Money is stored in santimat (minor units); the model should never have to divide. */
const toMajorUnits = (santimat: number): number => Math.round(santimat / 100)

/**
 * A tool result that tells the model its own arguments were unusable.
 *
 * Returned, not thrown. A throw degrades to the executor's generic bounded
 * `tool_execution_failed`, which the model cannot learn anything from; a returned
 * `{ error, hint }` lets it fix the argument and retry within the same loop. This is
 * for arguments the schema cannot express (a syntactically fine date string that is
 * not a real date) — never for an internal failure, which SHOULD degrade.
 */
const argError = (error: string, hint: string) => ({ error, hint })

/**
 * `current_date()` — the company's current date, so the model can resolve a relative
 * window ("next weekend", "this month") instead of guessing it.
 *
 * The `/assistant/context` snapshot used to carry `generatedAt`, which silently handed
 * the model "now". With the snapshot gone, a date-relative question like "which cars are
 * free next weekend?" left the model to hallucinate today's date — and it guessed the
 * wrong year. This restores that one fact as an explicit, on-demand tool: no arguments,
 * no DB, no PII. The model calls it first when a question is relative to now, then feeds
 * the resolved dates to `list_available_vehicles`.
 */
export const currentDate = {
  name: 'current_date',
  description:
    "Get the company's current date. Call this FIRST whenever a question is relative to " +
    "now — 'today', 'this week', 'next weekend', 'this month' — then use the returned date " +
    'to compute the exact window for the other tools. Takes no arguments.',
  inputSchema: { type: 'object', properties: {} },
  mode: 'read' as const,
  handler: async () => {
    const now = DateTime.now()
    return {
      today: now.toISODate() ?? '',
      weekday: now.weekdayLong ?? '',
      timezone: now.zoneName ?? '',
    }
  },
}

/**
 * `count_bookings({ status? })` — booking volume, optionally narrowed to one
 * lifecycle status. With no status it returns the full per-status breakdown, so the
 * model can answer "how many bookings?" and "how many are active?" from one call.
 */
export const countBookings = {
  name: 'count_bookings',
  description:
    "Count this company's bookings. Optionally narrow to a single lifecycle status " +
    '(quote, confirmed, active, completed, cancelled, no_show). With no status, returns ' +
    'the total plus a per-status breakdown.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: BOOKING_STATUSES,
        description: 'Optional lifecycle status to count.',
      },
    },
  },
  mode: 'read' as const,
  handler: async (args: Record<string, unknown>) => {
    const { default: Booking } = await import('#app/models/tenant_scoped/booking')
    const status = args.status as BookingStatus | undefined

    if (status) {
      const rows = await Booking.query()
        .where('status', status)
        .count('* as count')
        .pojo<{ count: number | string }>()
      return { status, count: Number(rows[0]?.count ?? 0) }
    }

    const rows = await Booking.query()
      .select('status')
      .count('* as count')
      .groupBy('status')
      .pojo<{ status: string; count: number | string }>()
    const byStatus = Object.fromEntries(BOOKING_STATUSES.map((s) => [s, 0])) as Record<
      BookingStatus,
      number
    >
    for (const row of rows) {
      if (row.status in byStatus) byStatus[row.status as BookingStatus] = Number(row.count)
    }
    return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus }
  },
}

/**
 * `count_vehicles({ status? })` — fleet size, optionally narrowed to one status.
 *
 * The twin of `count_bookings` for the vehicle table. With no status it returns the
 * total fleet size plus a per-status breakdown (available / rented / maintenance /
 * retired), so the model answers "how many cars do I have?" and "how many are in
 * maintenance?" from a single call. This is the count the `/assistant/context`
 * snapshot used to carry as `fleet.total` / `fleet.byStatus`; no tool covered it
 * before, so a bare "how big is my fleet?" had the model looping on
 * `list_available_vehicles` (which needs a date window and only lists free cars)
 * until it exhausted the round budget.
 *
 * Note this is a status count, not real availability: a car marked `available` may
 * still be booked for a given window. For "free between these dates" the model wants
 * `list_available_vehicles`, which does the overlap test.
 */
export const countVehicles = {
  name: 'count_vehicles',
  description:
    "Count this company's vehicles. Optionally narrow to a single status (available, " +
    'rented, maintenance, retired). With no status, returns the total fleet size plus a ' +
    'per-status breakdown. This is a status count, not date-window availability — for ' +
    'cars free between specific dates use list_available_vehicles.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: VEHICLE_STATUSES,
        description: 'Optional vehicle status to count.',
      },
    },
  },
  mode: 'read' as const,
  handler: async (args: Record<string, unknown>) => {
    const { default: Vehicle } = await import('#app/models/tenant_scoped/vehicle')
    const status = args.status as VehicleStatus | undefined

    if (status) {
      const rows = await Vehicle.query()
        .where('status', status)
        .count('* as count')
        .pojo<{ count: number | string }>()
      return { status, count: Number(rows[0]?.count ?? 0) }
    }

    const rows = await Vehicle.query()
      .select('status')
      .count('* as count')
      .groupBy('status')
      .pojo<{ status: string; count: number | string }>()
    const byStatus = Object.fromEntries(VEHICLE_STATUSES.map((s) => [s, 0])) as Record<
      VehicleStatus,
      number
    >
    for (const row of rows) {
      if (row.status in byStatus) byStatus[row.status as VehicleStatus] = Number(row.count)
    }
    return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus }
  },
}

/**
 * `list_available_vehicles({ from?, to? })` — the fleet actually free for a window.
 *
 * Availability is not just `status = 'available'`: a car already reserved for those
 * dates is not free. So it excludes any vehicle holding a confirmed/active booking
 * that OVERLAPS the window — the standard half-open test (`pickup < to AND dropoff >
 * from`), which correctly treats a booking ending exactly at `from` as no conflict.
 *
 * Both bounds are optional: omit them for what is free right now and the window defaults
 * to the next 24 hours (`from` = now, `to` = now + 1 day), so a bare "what can I rent out
 * today?" needs no date at all. Pass explicit dates for a specific window; for a RELATIVE
 * one ("this weekend") call `current_date` first to anchor it.
 */
export const listAvailableVehicles = {
  name: 'list_available_vehicles',
  description:
    'List the vehicles free to rent across a date window. Omit `from`/`to` for what is free ' +
    'right now (defaults to the next 24 hours). Pass explicit ISO-8601 dates (YYYY-MM-DD or a ' +
    'full timestamp) for a specific window; for a relative window like "this weekend" call ' +
    'current_date FIRST to anchor it — do not guess today. Excludes vehicles out of service ' +
    'and those already booked for any part of the window.',
  inputSchema: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        maxLength: 40,
        description: 'Window start, ISO-8601. Optional; defaults to now.',
      },
      to: {
        type: 'string',
        maxLength: 40,
        description: 'Window end, ISO-8601. Optional; defaults to one day after `from`.',
      },
    },
  },
  mode: 'read' as const,
  handler: async (args: Record<string, unknown>) => {
    const now = DateTime.now()
    const from = args.from !== undefined ? DateTime.fromISO(String(args.from)) : now
    const to = args.to !== undefined ? DateTime.fromISO(String(args.to)) : from.plus({ days: 1 })
    if (!from.isValid || !to.isValid) {
      return argError(
        'invalid_date',
        'Provide `from`/`to` as ISO-8601, e.g. 2026-07-20 — or omit them for right now.'
      )
    }
    if (to <= from) {
      return argError('empty_window', '`to` must be after `from`.')
    }

    const { default: Booking } = await import('#app/models/tenant_scoped/booking')
    const { default: Vehicle } = await import('#app/models/tenant_scoped/vehicle')

    // Vehicles busy for any part of the window: half-open overlap.
    const busy = await Booking.query()
      .whereIn('status', ['confirmed', 'active'])
      .where('pickup_at', '<', to.toSQL({ includeOffset: false })!)
      .where('dropoff_at', '>', from.toSQL({ includeOffset: false })!)
      .distinct('vehicle_id')
      .pojo<{ vehicle_id: string }>()
    const busyIds = busy.map((row) => row.vehicle_id)

    const query = Vehicle.query().where('status', 'available')
    if (busyIds.length > 0) query.whereNotIn('id', busyIds)
    const vehicles = await query.orderBy('make_name').limit(25)

    return {
      window: { from: from.toISODate(), to: to.toISODate() },
      available: vehicles.length,
      vehicles: vehicles.map((v) => ({
        plate: v.plate,
        vehicle: `${v.makeName} ${v.modelName}`,
        year: v.year,
        transmission: v.transmission,
        fuel: v.fuel,
      })),
    }
  },
}

/**
 * `revenue_summary({ period })` — booked revenue over a named period.
 *
 * Counts only bookings that became real rentals (active/completed), so a quote or a
 * cancellation never inflates the figure. Periods are an enum rather than free dates:
 * the model asks for a business period, the app owns what that means.
 */
export const revenueSummary = {
  name: 'revenue_summary',
  description:
    'Total booked revenue for a named period: month_to_date, last_month, or ' +
    'year_to_date. Counts only bookings that became real rentals (active or completed).',
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['month_to_date', 'last_month', 'year_to_date'],
        description: 'The business period to total.',
      },
    },
    required: ['period'],
  },
  mode: 'read' as const,
  handler: async (args: Record<string, unknown>) => {
    const period = args.period as 'month_to_date' | 'last_month' | 'year_to_date'
    const now = DateTime.now()
    const range =
      period === 'last_month'
        ? { start: now.minus({ months: 1 }).startOf('month'), end: now.startOf('month') }
        : period === 'year_to_date'
          ? { start: now.startOf('year'), end: null }
          : { start: now.startOf('month'), end: null }

    const { default: Booking } = await import('#app/models/tenant_scoped/booking')
    const query = Booking.query()
      .whereIn('status', ['active', 'completed'])
      .where('created_at', '>=', range.start.toSQL({ includeOffset: false })!)
    if (range.end) {
      query.where('created_at', '<', range.end.toSQL({ includeOffset: false })!)
    }
    const rows = await query.sum('total_amount as total').pojo<{ total: string | null }>()
    const currencyRow = await Booking.query().select('currency').first()

    return {
      period,
      from: range.start.toISODate(),
      amount: toMajorUnits(Number(rows[0]?.total ?? 0)),
      currency: currencyRow?.currency ?? 'MAD',
    }
  },
}

/**
 * `top_rented_vehicles({ limit? })` — the fleet ranked by real rentals.
 *
 * Resolves the ranked ids to human labels (make/model/plate are fleet assets, not
 * PII). A historical booking may point at a since-removed vehicle, so a missing row
 * falls back to its id rather than dropping the rank.
 */
export const topRentedVehicles = {
  name: 'top_rented_vehicles',
  description:
    "Rank this company's vehicles by how many real rentals they have had, most first. " +
    '`limit` defaults to 5 and is capped at 10.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'How many vehicles to return (1-10, default 5).',
      },
    },
  },
  mode: 'read' as const,
  handler: async (args: Record<string, unknown>) => {
    const limit = typeof args.limit === 'number' ? args.limit : 5
    const { default: Booking } = await import('#app/models/tenant_scoped/booking')
    const { default: Vehicle } = await import('#app/models/tenant_scoped/vehicle')

    const ranked = await Booking.query()
      .whereIn('status', RENTAL_STATUSES)
      .select('vehicle_id')
      .count('* as rentals')
      .groupBy('vehicle_id')
      .orderBy('rentals', 'desc')
      .limit(limit)
      .pojo<{ vehicle_id: string; rentals: number | string }>()

    const ids = ranked.map((r) => r.vehicle_id)
    const byId = new Map(
      ids.length ? (await Vehicle.query().whereIn('id', ids)).map((v) => [v.id, v]) : []
    )
    return {
      ranked: ranked.map((r) => {
        const v = byId.get(r.vehicle_id)
        return {
          vehicle: v ? `${v.makeName} ${v.modelName} (${v.plate})` : r.vehicle_id,
          rentals: Number(r.rentals),
        }
      }),
    }
  },
}

/** The read-only tools offered to the fleet assistant. */
export const fleetTools = [
  currentDate,
  countBookings,
  countVehicles,
  listAvailableVehicles,
  revenueSummary,
  topRentedVehicles,
]

/** Tools an agent may call. The owner may call everything. */
const AGENT_TOOLS = new Set([
  'current_date',
  'count_bookings',
  'count_vehicles',
  'list_available_vehicles',
  'top_rented_vehicles',
])

/**
 * Resolve the staff member behind this request, whichever realm they came through.
 *
 * TenantGuardMiddleware has already run `authorizeTenantAccess` by the time a tool is
 * called, and that gate authenticates one of the two guards: `tenant` for a bearer
 * token, `web-tenant` for a pinned browser session. Both point at the same
 * `TenantUser` model in the resolved company's schema, so either one's `.user` is
 * this company's staff. Returns null when neither authenticated, which the caller
 * treats as a deny.
 */
function resolveStaff(ctx: HttpContext): { role?: string; email?: string } | null {
  try {
    const auth = ctx.auth as unknown as {
      use: (name: string) => { user?: { role?: string; email?: string } }
    }
    return auth?.use('web-tenant')?.user ?? auth?.use('tenant')?.user ?? null
  } catch {
    // A guard that was never initialised is not an authorization: fail closed.
    return null
  }
}

/**
 * `config.ai.tools.authorizeTool` — the per-tool gate (WS-AI-11).
 *
 * Wiring this is what keeps the company off `acknowledgeUnauthorizedTools`, the
 * escape hatch that runs tools with no authorization at all. Membership is already
 * proven upstream by the tenant guard, so this is not "is the caller staff of this
 * company?" — it is "may THIS staff member run THIS tool?".
 *
 * Revenue is the owner's business: an agent runs the counter (bookings, fleet,
 * availability) but is not shown the company's takings. Read tools are otherwise
 * open to both roles. Anything unrecognised — an unknown role, no resolvable staff —
 * denies, so the gate stays fail-closed as the satellite expects.
 */
export function authorizeFleetTool(ctx: HttpContext, _tenant: TenantModelContract, tool: string) {
  const staff = resolveStaff(ctx)
  if (!staff) return { kind: 'deny' as const }
  if (staff.role === 'owner') return { kind: 'allow' as const }
  if (staff.role === 'agent' && AGENT_TOOLS.has(tool)) return { kind: 'allow' as const }
  return { kind: 'deny' as const }
}
