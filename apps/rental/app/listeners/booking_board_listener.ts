import type { Emitter } from '@adonisjs/core/events'
import app from '@adonisjs/core/services/app'
import { TenantDataChanged } from '@adonisjs-lasagna/saas-tenancy/mixins'
import { TenantSocketServer } from '@adonisjs-lasagna/websockets'

/**
 * Bridges committed booking writes to the company's live reservations board.
 * `TenantDataChanged` is PII-free (`{ tenantId, table, operation, keys }`), so
 * forwarding it to the tenant room leaks nothing; a client re-reads if it needs
 * detail. Isolation is structural: `emitToTenant` targets only `tenant:<id>`.
 *
 * WebSockets are an optional peer — if socket.io is not installed the server is
 * inert and `emitToTenant` is a safe no-op.
 */
export default class BookingBoardListener {
  static register(emitter: Emitter<any>) {
    emitter.on(TenantDataChanged, async (event: any) => {
      const change = event.change ?? event
      if (change?.table !== 'bookings') return
      try {
        const sockets = await app.container.make(TenantSocketServer)
        sockets.emitToTenant(change.tenantId, 'booking:changed', {
          table: change.table,
          operation: change.operation,
          keys: change.keys,
        })
      } catch {
        /* websockets disabled (no socket.io) — nothing to broadcast */
      }
    })
  }
}
