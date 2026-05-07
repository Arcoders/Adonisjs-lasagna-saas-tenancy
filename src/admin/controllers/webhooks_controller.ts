import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import WebhookService from '../../services/webhook_service.js'
import TenantWebhook from '../../models/satellites/tenant_webhook.js'
import TenantWebhookDelivery from '../../models/satellites/tenant_webhook_delivery.js'
import { loadTenantOr404, isNonEmptyString, validateExternalHttpsUrl } from './helpers.js'

function serialize(w: TenantWebhook) {
  return {
    id: w.id,
    tenantId: w.tenantId,
    url: w.url,
    events: w.events,
    enabled: w.enabled,
    // We never expose the encrypted secret. Whether one is configured is
    // disclosed via a boolean — useful for UIs that want to show "secret set".
    hasSecret: !!w.secret,
    createdAt: w.createdAt?.toISO?.() ?? null,
    updatedAt: w.updatedAt?.toISO?.() ?? null,
  }
}

function serializeDelivery(d: TenantWebhookDelivery) {
  return {
    id: d.id,
    webhookId: d.webhookId,
    event: d.event,
    status: d.status,
    statusCode: d.statusCode,
    attempt: d.attempt,
    nextRetryAt: d.nextRetryAt?.toISO?.() ?? null,
    createdAt: d.createdAt?.toISO?.() ?? null,
  }
}

export default class WebhooksController {
  async list(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const svc = await app.container.make(WebhookService)
    const hooks = await svc.listWebhooks(tenant.id)
    return ctx.response.ok({ data: hooks.map(serialize) })
  }

  async create(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    const url = ctx.request.input('url')
    const events = ctx.request.input('events')
    const secret = ctx.request.input('secret')

    const urlError = validateExternalHttpsUrl(url)
    if (urlError) return ctx.response.badRequest({ error: urlError })
    if (!Array.isArray(events) || events.length === 0 || !events.every(isNonEmptyString)) {
      return ctx.response.badRequest({ error: 'events_required_non_empty_array' })
    }

    const svc = await app.container.make(WebhookService)
    const hook = await svc.registerWebhook(
      tenant.id,
      url,
      events,
      isNonEmptyString(secret) ? secret : undefined
    )
    return ctx.response.created({ data: serialize(hook) })
  }

  async update(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    const hook = await TenantWebhook.query()
      .where('id', ctx.params.webhookId)
      .where('tenant_id', tenant.id)
      .first()
    if (!hook) return ctx.response.notFound({ error: 'webhook_not_found' })

    const url = ctx.request.input('url')
    const events = ctx.request.input('events')
    const enabled = ctx.request.input('enabled')

    if (url !== undefined) {
      const urlError = validateExternalHttpsUrl(url)
      if (urlError) return ctx.response.badRequest({ error: urlError })
      hook.url = url
    }
    if (events !== undefined) {
      if (!Array.isArray(events) || !events.every(isNonEmptyString)) {
        return ctx.response.badRequest({ error: 'events_must_be_string_array' })
      }
      hook.events = events
    }
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return ctx.response.badRequest({ error: 'enabled_must_be_boolean' })
      }
      hook.enabled = enabled
    }
    await hook.save()
    return ctx.response.ok({ data: serialize(hook) })
  }

  async destroy(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const svc = await app.container.make(WebhookService)
    await svc.deleteWebhook(ctx.params.webhookId, tenant.id)
    return ctx.response.noContent()
  }

  async listDeliveries(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const hook = await TenantWebhook.query()
      .where('id', ctx.params.webhookId)
      .where('tenant_id', tenant.id)
      .first()
    if (!hook) return ctx.response.notFound({ error: 'webhook_not_found' })

    const deliveries = await TenantWebhookDelivery.query()
      .where('webhook_id', hook.id)
      .orderBy('created_at', 'desc')
      .limit(100)
    return ctx.response.ok({ data: deliveries.map(serializeDelivery) })
  }

  async retryDelivery(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    const delivery = await TenantWebhookDelivery.query()
      .where('id', ctx.params.deliveryId)
      .preload('webhook')
      .first()
    if (!delivery) return ctx.response.notFound({ error: 'delivery_not_found' })
    if (delivery.webhook.tenantId !== tenant.id) {
      return ctx.response.forbidden({ error: 'delivery_belongs_to_other_tenant' })
    }

    // Re-validate the stored URL before re-sending. A webhook URL that
    // was acceptable at registration time could still be a SSRF vector
    // today (e.g. DNS rebinding, or someone disabling validation in a
    // prior version). Refuse instead of fetching.
    const urlError = validateExternalHttpsUrl(delivery.webhook.url)
    if (urlError) {
      return ctx.response.unprocessableEntity({
        error: 'webhook_url_unsafe',
        code: urlError,
      })
    }

    const svc = await app.container.make(WebhookService)
    await svc.send(delivery.webhook, delivery)
    return ctx.response.ok({ data: serializeDelivery(delivery) })
  }
}
