import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import WebhookService from '../services/webhook_service.js'

export default class TenantWebhooksRetry extends BaseCommand {
  static readonly commandName = 'tenant:webhooks:retry'
  static readonly description = 'Process pending webhook retries for all tenants'
  static readonly options: CommandOptions = { startApp: true }

  async run() {
    const service = new WebhookService()
    await service.processRetries()
    this.logger.success('Webhook retries processed')
  }
}
