import type { HttpContext } from '@adonisjs/core/http'
import { TenantWebhook } from '@adonisjs-lasagna/saas-tenancy'
import { WebhookService } from '@adonisjs-lasagna/saas-tenancy/services'
import {
  fireWebhookValidator,
  subscribeWebhookValidator,
} from '#app/validators/webhooks_validator'

const webhooks = new WebhookService()

/**
 * Subscriber CRUD + a "fire a test event" endpoint. Real apps usually expose
 * webhook management through their own admin UI; the demo routes are
 * deliberately bare so the wiring is obvious.
 */
export default class WebhooksController {
  async list({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const subscriptions = await TenantWebhook.query().where('tenant_id', tenant.id)
    return response.ok({ subscriptions })
  }

  async subscribe({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const payload = await request.validateUsing(subscribeWebhookValidator)
    const subscription = await new TenantWebhook()
      .merge({
        tenantId: tenant.id,
        url: payload.url,
        events: payload.events,
        secret: payload.secret ?? null,
        enabled: true,
      })
      .save()
    return response.created({ subscription })
  }

  async fire({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const payload = await request.validateUsing(fireWebhookValidator)
    await webhooks.dispatch(tenant.id, payload.event, payload.payload ?? {})
    return response.accepted({
      dispatched: payload.event,
      hint: 'Run `node ace tenant:webhooks:retry` to flush failed deliveries',
    })
  }
}
