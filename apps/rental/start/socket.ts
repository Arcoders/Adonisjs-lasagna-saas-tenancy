import app from '@adonisjs/core/services/app'
import { TenantSocketServer } from '@adonisjs-lasagna/websockets'

/**
 * WebSockets wiring for the live reservations board. The websockets provider
 * attaches socket.io to the HTTP server and joins each connection to its
 * company room (`tenant:<uuid>`) from the handshake `auth.tenantId`. Booking
 * updates arrive as `booking:changed` broadcasts (see BookingBoardListener); a
 * `board:ping` round-trip lets a client confirm its room membership.
 *
 * Requires socket.io (`npm i socket.io`). Without it the provider logs a notice
 * and WebSockets stay off; the rest of the app is unaffected.
 */
const sockets = await app.container.make(TenantSocketServer)

sockets.onConnection((socket) => {
  sockets.onTenantEvent(socket, 'board:ping', async () => {
    sockets.broadcastToTenant('board:pong', { at: new Date().toISOString() })
  })
})
