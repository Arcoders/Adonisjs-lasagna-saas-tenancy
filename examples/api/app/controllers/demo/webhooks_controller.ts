import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { TenantWebhook, writeSecret } from '@adonisjs-lasagna/saas-tenancy'
import { WebhookService } from '@adonisjs-lasagna/saas-tenancy/services'
import { fireWebhookValidator, subscribeWebhookValidator } from '#app/validators/webhooks_validator'

/**
 * Subscriber CRUD + a "fire a test event" endpoint. Real apps usually expose
 * webhook management through their own admin UI; the demo routes are
 * deliberately bare so the wiring is obvious.
 */
@inject()
export default class WebhooksController {
  constructor(private readonly webhooks: WebhookService) {}

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
        // Webhook signing secrets are stored encrypted under the webhook secret
        // class; the delivery path reads them with a strict, per-class decrypt and
        // fails closed on anything else. Write through writeSecret so the stored
        // value is ciphertext for that exact class (a bare encrypt() would use the
        // default context and fail the per-class read at delivery time).
        secret: payload.secret ? writeSecret(payload.secret, 'webhookSecret') : null,
        enabled: true,
      })
      .save()
    return response.created({ subscription })
  }

  async fire({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const payload = await request.validateUsing(fireWebhookValidator)
    await this.webhooks.dispatch(tenant.id, payload.event, payload.payload ?? {})
    return response.accepted({
      dispatched: payload.event,
      hint: 'Run `node ace tenant:webhooks:retry` to flush failed deliveries',
    })
  }
}
