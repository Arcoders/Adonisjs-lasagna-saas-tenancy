import app from '@adonisjs/core/services/app'
import { TenantSocketServer } from '@adonisjs-lasagna/websockets'
import ChatMessage from '#app/models/tenant_scoped/chat_message'

/**
 * WebSockets demo wiring. The `@adonisjs-lasagna/websockets` provider attaches
 * socket.io to the HTTP server and isolates each connection by tenant (resolved
 * from `io(url, { auth: { tenantId } })` at the handshake). Here we register the
 * chat handlers.
 *
 * Every handler is registered through `onTenantEvent`, so it runs inside the
 * connecting tenant's context: the `ChatMessage` write lands in
 * `tenant_<uuid>.chat_messages`, and `broadcastToTenant` reaches only that
 * tenant's room. A bare `socket.on(...)` would run with no tenant context and
 * its query would throw.
 *
 * Requires socket.io (`npm i socket.io`). Without it the provider logs a notice
 * and WebSockets stay off. The rest of the app is unaffected.
 */
const sockets = await app.container.make(TenantSocketServer)

sockets.onConnection((socket) => {
  sockets.onTenantEvent(socket, 'chat:send', async (text: unknown) => {
    const message = await ChatMessage.create({ body: String(text ?? '').slice(0, 2000) })
    sockets.broadcastToTenant('chat:new', { id: message.id, body: message.body })
  })
})
