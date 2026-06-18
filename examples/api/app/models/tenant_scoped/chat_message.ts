import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * A tenant-scoped chat message. Lives in `tenant_<uuid>.chat_messages` thanks to
 * TenantBaseModel routing. The WebSockets demo (start/socket.ts) writes rows here
 * from inside a socket event handler — proving that a query made over a live
 * WebSocket connection still lands in the connecting tenant's schema.
 */
export default class ChatMessage extends TenantBaseModel {
  static table = 'chat_messages'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare body: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
