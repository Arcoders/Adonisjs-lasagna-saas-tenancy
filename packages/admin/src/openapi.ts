/**
 * OpenAPI 3.1 spec for the multitenancy admin REST API. Built declaratively
 * so the router and the spec can be cross-checked by a test (`tests/unit/admin/openapi.spec.ts`).
 *
 * Schemas mirror the controller serializers — when you add a field to a
 * `serialize()` function, mirror it here.
 */

export interface OpenApiDocument {
  openapi: '3.1.0'
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, unknown>>
  components: {
    schemas: Record<string, unknown>
    parameters: Record<string, unknown>
    responses: Record<string, unknown>
  }
}

const TAG_TENANTS = 'Tenants'
const TAG_OBSERVABILITY = 'Observability'
const TAG_IMPERSONATION = 'Impersonation'
const TAG_SATELLITES = 'Satellites'

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` }
}

function paramRef(name: string) {
  return { $ref: `#/components/parameters/${name}` }
}

function jsonBody(schemaRef: any, required = false) {
  return {
    required,
    content: { 'application/json': { schema: schemaRef } },
  }
}

function jsonResponse(description: string, schemaRef?: any, status = 200) {
  return {
    [String(status)]: {
      description,
      ...(schemaRef ? { content: { 'application/json': { schema: schemaRef } } } : {}),
    },
  }
}

function notFound(resource: string) {
  return jsonResponse(`${resource} not found`, ref('Error'), 404)
}

const schemas = {
  Tenant: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      status: {
        type: 'string',
        enum: ['provisioning', 'active', 'suspended', 'failed', 'deleted'],
      },
      customDomain: { type: ['string', 'null'] },
      schemaName: { type: 'string' },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      deletedAt: { type: ['string', 'null'], format: 'date-time' },
      isActive: { type: 'boolean' },
      isDeleted: { type: 'boolean' },
      metadata: { type: ['object', 'null'] },
    },
    required: ['id', 'name', 'email', 'status'],
  },
  TenantList: {
    type: 'object',
    properties: {
      data: { type: 'array', items: ref('Tenant') },
      total: { type: 'integer' },
    },
  },
  TenantSingle: {
    type: 'object',
    properties: { data: ref('Tenant') },
  },
  TenantCreate: {
    type: 'object',
    required: ['name', 'email'],
    properties: {
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
    },
  },
  AuditLog: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tenantId: { type: ['string', 'null'] },
      actorType: { type: 'string' },
      actorId: { type: ['string', 'null'] },
      action: { type: 'string' },
      metadata: { type: ['object', 'null'] },
      ipAddress: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Webhook: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tenantId: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      events: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean' },
      hasSecret: { type: 'boolean' },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  WebhookCreate: {
    type: 'object',
    required: ['url', 'events'],
    properties: {
      url: { type: 'string', format: 'uri' },
      events: { type: 'array', items: { type: 'string' }, minItems: 1 },
      secret: { type: 'string', description: 'Plain-text shared secret. Stored encrypted.' },
    },
  },
  WebhookUpdate: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      events: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean' },
    },
  },
  WebhookDelivery: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      webhookId: { type: 'string' },
      event: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'success', 'failed', 'retrying'] },
      statusCode: { type: ['integer', 'null'] },
      attempt: { type: 'integer' },
      nextRetryAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  FeatureFlag: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tenantId: { type: 'string' },
      flag: { type: 'string' },
      enabled: { type: 'boolean' },
      config: { type: ['object', 'null'] },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  FeatureFlagInput: {
    type: 'object',
    required: ['flag', 'enabled'],
    properties: {
      flag: { type: 'string' },
      enabled: { type: 'boolean' },
      config: { type: 'object' },
    },
  },
  Branding: {
    type: 'object',
    properties: {
      tenantId: { type: 'string' },
      fromName: { type: ['string', 'null'] },
      fromEmail: { type: ['string', 'null'] },
      logoUrl: { type: ['string', 'null'], format: 'uri' },
      primaryColor: { type: ['string', 'null'], description: 'CSS hex color, e.g. `#3b82f6`.' },
      supportUrl: { type: ['string', 'null'], format: 'uri' },
      emailFooter: { type: ['object', 'null'] },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  BrandingUpdate: {
    type: 'object',
    properties: {
      fromName: { type: 'string' },
      fromEmail: { type: 'string', format: 'email' },
      logoUrl: { type: 'string', format: 'uri' },
      primaryColor: { type: 'string' },
      supportUrl: { type: 'string', format: 'uri' },
      emailFooter: { type: 'object' },
    },
  },
  SsoConfig: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tenantId: { type: 'string' },
      provider: { type: 'string' },
      clientId: { type: 'string' },
      issuerUrl: { type: 'string', format: 'uri' },
      redirectUri: { type: 'string', format: 'uri' },
      scopes: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean' },
      hasClientSecret: { type: 'boolean' },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  SsoConfigUpdate: {
    type: 'object',
    required: ['clientId', 'clientSecret', 'issuerUrl', 'redirectUri'],
    properties: {
      clientId: { type: 'string' },
      clientSecret: { type: 'string' },
      issuerUrl: { type: 'string', format: 'uri' },
      redirectUri: { type: 'string', format: 'uri' },
      scopes: { type: 'array', items: { type: 'string' } },
    },
  },
  Metric: {
    type: 'object',
    properties: {
      tenantId: { type: 'string' },
      period: { type: 'string', description: 'YYYY-MM-DD' },
      requestCount: { type: 'integer' },
      errorCount: { type: 'integer' },
      bandwidthBytes: { type: 'integer' },
    },
  },
  QuotaSnapshot: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      limits: { type: 'object', additionalProperties: { type: 'number' } },
      usage: { type: 'object', additionalProperties: { type: 'number' } },
    },
  },
  QueueStats: {
    type: 'object',
    properties: {
      tenantId: { type: 'string' },
      queueName: { type: 'string' },
      waiting: { type: 'integer' },
      active: { type: 'integer' },
      completed: { type: 'integer' },
      failed: { type: 'integer' },
      delayed: { type: 'integer' },
    },
  },
  HealthReport: {
    type: 'object',
    properties: {
      reports: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            check: { type: 'string' },
            description: { type: 'string' },
            durationMs: { type: 'number' },
            issues: { type: 'array', items: ref('Issue') },
            error: { type: 'string' },
          },
        },
      },
      totals: {
        type: 'object',
        properties: {
          info: { type: 'integer' },
          warn: { type: 'integer' },
          error: { type: 'integer' },
          fixable: { type: 'integer' },
        },
      },
    },
  },
  Issue: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      severity: { type: 'string', enum: ['info', 'warn', 'error'] },
      message: { type: 'string' },
      tenantId: { type: 'string' },
      fixable: { type: 'boolean' },
      meta: { type: 'object' },
    },
  },
  Impersonation: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      token: { type: 'string' },
      expiresAt: { type: 'string', format: 'date-time' },
    },
  },
  ImpersonationStart: {
    type: 'object',
    required: ['userId'],
    properties: {
      userId: { type: 'string' },
      durationSeconds: { type: 'number' },
      reason: { type: 'string' },
    },
  },
  Error: {
    type: 'object',
    properties: {
      error: { type: 'string' },
      message: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['error'],
  },
}

const parameters = {
  TenantId: {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  },
  WebhookId: {
    name: 'webhookId',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  },
  DeliveryId: {
    name: 'deliveryId',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  },
  FlagKey: {
    name: 'flagKey',
    in: 'path',
    required: true,
    schema: { type: 'string' },
  },
  Page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
  Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
}

/**
 * Build the OpenAPI spec rooted at `prefix`. The prefix is part of every
 * path key — e.g. `prefix='/admin/multitenancy'` yields
 * `/admin/multitenancy/tenants` keys.
 */
export function getOpenAPISpec(prefix = '/admin/multitenancy'): OpenApiDocument {
  const p = prefix.replace(/\/$/, '') || ''
  const base = p === '' ? '' : p

  const paths: Record<string, Record<string, unknown>> = {
    [`${base}/tenants`]: {
      get: {
        tags: [TAG_TENANTS],
        summary: 'List tenants',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'includeDeleted', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: jsonResponse('OK', ref('TenantList')),
      },
      post: {
        tags: [TAG_TENANTS],
        summary: 'Create tenant',
        requestBody: jsonBody(ref('TenantCreate'), true),
        responses: {
          ...jsonResponse('Created', ref('TenantSingle'), 201),
          ...jsonResponse('Bad request', ref('Error'), 400),
        },
      },
    },
    [`${base}/tenants/{id}`]: {
      get: {
        tags: [TAG_TENANTS],
        summary: 'Show tenant',
        parameters: [paramRef('TenantId')],
        responses: { ...jsonResponse('OK', ref('TenantSingle')), ...notFound('Tenant') },
      },
    },
    [`${base}/tenants/{id}/activate`]: {
      post: {
        tags: [TAG_TENANTS],
        parameters: [paramRef('TenantId')],
        responses: { ...jsonResponse('OK', ref('TenantSingle')), ...notFound('Tenant') },
      },
    },
    [`${base}/tenants/{id}/suspend`]: {
      post: {
        tags: [TAG_TENANTS],
        parameters: [paramRef('TenantId')],
        responses: { ...jsonResponse('OK', ref('TenantSingle')), ...notFound('Tenant') },
      },
    },
    [`${base}/tenants/{id}/destroy`]: {
      post: {
        tags: [TAG_TENANTS],
        parameters: [
          paramRef('TenantId'),
          { name: 'keepSchema', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { ...jsonResponse('OK', ref('TenantSingle')), ...notFound('Tenant') },
      },
    },
    [`${base}/tenants/{id}/restore`]: {
      post: {
        tags: [TAG_TENANTS],
        parameters: [paramRef('TenantId')],
        responses: { ...jsonResponse('OK', ref('TenantSingle')), ...notFound('Tenant') },
      },
    },
    [`${base}/tenants/{id}/maintenance`]: {
      post: {
        tags: [TAG_TENANTS],
        summary: 'Enter maintenance mode',
        parameters: [paramRef('TenantId')],
        requestBody: jsonBody({
          type: 'object',
          properties: { message: { type: 'string' } },
        }),
        responses: { ...jsonResponse('OK', ref('TenantSingle')), ...notFound('Tenant') },
      },
      delete: {
        tags: [TAG_TENANTS],
        summary: 'Exit maintenance mode',
        parameters: [paramRef('TenantId')],
        responses: { ...jsonResponse('OK', ref('TenantSingle')), ...notFound('Tenant') },
      },
    },
    [`${base}/tenants/{id}/queue/stats`]: {
      get: {
        tags: [TAG_OBSERVABILITY],
        parameters: [paramRef('TenantId')],
        responses: jsonResponse('OK', { type: 'object', properties: { data: ref('QueueStats') } }),
      },
    },
    [`${base}/health/report`]: {
      get: {
        tags: [TAG_OBSERVABILITY],
        summary: 'Run all doctor checks',
        responses: {
          ...jsonResponse('OK', ref('HealthReport')),
          ...jsonResponse('At least one check reported errors', ref('HealthReport'), 503),
        },
      },
    },
    [`${base}/openapi.json`]: {
      get: {
        tags: [TAG_OBSERVABILITY],
        summary: 'OpenAPI 3.1 spec for this admin API',
        responses: jsonResponse('OK', { type: 'object' }),
      },
    },
    [`${base}/docs`]: {
      get: {
        tags: [TAG_OBSERVABILITY],
        summary: 'Swagger UI',
        responses: { 200: { description: 'HTML page' } },
      },
    },
    [`${base}/tenants/{id}/impersonations`]: {
      post: {
        tags: [TAG_IMPERSONATION],
        parameters: [paramRef('TenantId')],
        requestBody: jsonBody(ref('ImpersonationStart'), true),
        responses: {
          ...jsonResponse(
            'Created',
            { type: 'object', properties: { data: ref('Impersonation') } },
            201
          ),
          ...jsonResponse('Admin actor resolver not configured', ref('Error'), 501),
          ...jsonResponse('Admin actor unresolved', ref('Error'), 401),
        },
      },
    },
    [`${base}/impersonations/{token}`]: {
      delete: {
        tags: [TAG_IMPERSONATION],
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: jsonResponse('OK', {
          type: 'object',
          properties: { revoked: { type: 'boolean' } },
        }),
      },
    },
    [`${base}/impersonations/by-id/{sessionId}`]: {
      delete: {
        tags: [TAG_IMPERSONATION],
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: jsonResponse('OK', {
          type: 'object',
          properties: { revoked: { type: 'boolean' } },
        }),
      },
    },
    [`${base}/tenants/{id}/audit-logs`]: {
      get: {
        tags: [TAG_SATELLITES],
        parameters: [
          paramRef('TenantId'),
          paramRef('Page'),
          paramRef('Limit'),
          {
            name: 'from',
            in: 'query',
            description: 'ISO 8601 lower bound on `created_at` (inclusive).',
            required: false,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'to',
            in: 'query',
            description: 'ISO 8601 upper bound on `created_at` (inclusive).',
            required: false,
            schema: { type: 'string', format: 'date-time' },
          },
        ],
        responses: jsonResponse('OK', {
          type: 'object',
          properties: {
            data: { type: 'array', items: ref('AuditLog') },
            meta: { type: 'object' },
          },
        }),
      },
    },
    [`${base}/tenants/{id}/webhooks`]: {
      get: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        responses: jsonResponse('OK', {
          type: 'object',
          properties: { data: { type: 'array', items: ref('Webhook') } },
        }),
      },
      post: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        requestBody: jsonBody(ref('WebhookCreate'), true),
        responses: {
          ...jsonResponse('Created', { type: 'object', properties: { data: ref('Webhook') } }, 201),
          ...jsonResponse('Bad request', ref('Error'), 400),
        },
      },
    },
    [`${base}/tenants/{id}/webhooks/{webhookId}`]: {
      put: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId'), paramRef('WebhookId')],
        requestBody: jsonBody(ref('WebhookUpdate')),
        responses: {
          ...jsonResponse('OK', { type: 'object', properties: { data: ref('Webhook') } }),
          ...notFound('Webhook'),
        },
      },
      delete: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId'), paramRef('WebhookId')],
        responses: { 204: { description: 'No content' }, ...notFound('Tenant') },
      },
    },
    [`${base}/tenants/{id}/webhooks/{webhookId}/deliveries`]: {
      get: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId'), paramRef('WebhookId')],
        responses: jsonResponse('OK', {
          type: 'object',
          properties: { data: { type: 'array', items: ref('WebhookDelivery') } },
        }),
      },
    },
    [`${base}/tenants/{id}/webhooks/deliveries/{deliveryId}/retry`]: {
      post: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId'), paramRef('DeliveryId')],
        responses: jsonResponse('OK', {
          type: 'object',
          properties: { data: ref('WebhookDelivery') },
        }),
      },
    },
    [`${base}/tenants/{id}/feature-flags`]: {
      get: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        responses: jsonResponse('OK', {
          type: 'object',
          properties: { data: { type: 'array', items: ref('FeatureFlag') } },
        }),
      },
      post: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        requestBody: jsonBody(ref('FeatureFlagInput'), true),
        responses: jsonResponse(
          'Created',
          { type: 'object', properties: { data: ref('FeatureFlag') } },
          201
        ),
      },
    },
    [`${base}/tenants/{id}/feature-flags/{flagKey}`]: {
      put: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId'), paramRef('FlagKey')],
        requestBody: jsonBody({
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' }, config: { type: 'object' } },
        }),
        responses: jsonResponse('OK', { type: 'object', properties: { data: ref('FeatureFlag') } }),
      },
      delete: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId'), paramRef('FlagKey')],
        responses: { 204: { description: 'No content' } },
      },
    },
    [`${base}/tenants/{id}/branding`]: {
      get: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        responses: jsonResponse('OK', { type: 'object', properties: { data: ref('Branding') } }),
      },
      put: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        requestBody: jsonBody(ref('BrandingUpdate')),
        responses: jsonResponse('OK', { type: 'object', properties: { data: ref('Branding') } }),
      },
    },
    [`${base}/tenants/{id}/sso`]: {
      get: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        responses: jsonResponse('OK', { type: 'object', properties: { data: ref('SsoConfig') } }),
      },
      put: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        requestBody: jsonBody(ref('SsoConfigUpdate'), true),
        responses: jsonResponse('OK', { type: 'object', properties: { data: ref('SsoConfig') } }),
      },
    },
    [`${base}/tenants/{id}/sso/disable`]: {
      post: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        responses: {
          ...jsonResponse('OK', { type: 'object', properties: { data: ref('SsoConfig') } }),
          ...notFound('SSO config'),
        },
      },
    },
    [`${base}/tenants/{id}/metrics`]: {
      get: {
        tags: [TAG_SATELLITES],
        parameters: [
          paramRef('TenantId'),
          { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365 } },
        ],
        responses: jsonResponse('OK', {
          type: 'object',
          properties: {
            data: { type: 'array', items: ref('Metric') },
            days: { type: 'integer' },
          },
        }),
      },
    },
    [`${base}/tenants/{id}/quotas`]: {
      get: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        responses: {
          ...jsonResponse('OK', { type: 'object', properties: { data: ref('QuotaSnapshot') } }),
          ...jsonResponse('Quotas not configured', ref('Error'), 503),
        },
      },
    },
    [`${base}/tenants/{id}/quotas/usage`]: {
      put: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        requestBody: jsonBody({
          type: 'object',
          required: ['quota', 'value'],
          properties: { quota: { type: 'string' }, value: { type: 'number', minimum: 0 } },
        }),
        responses: jsonResponse('OK', { type: 'object' }),
      },
    },
    [`${base}/tenants/{id}/quotas/reset`]: {
      post: {
        tags: [TAG_SATELLITES],
        parameters: [paramRef('TenantId')],
        requestBody: jsonBody({ type: 'object', properties: { quota: { type: 'string' } } }),
        responses: jsonResponse('OK', { type: 'object' }),
      },
    },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Lasagna Multitenancy Admin API',
      version: '2.0.0',
      description:
        'REST API for managing tenants and their satellite features (audit logs, webhooks, feature flags, branding, SSO, metrics, quotas) in `@adonisjs-lasagna/saas-tenancy`.',
    },
    paths,
    components: {
      schemas,
      parameters,
      responses: {},
    },
  }
}

/**
 * Returns every path key declared in the spec, useful for cross-checking
 * router registrations.
 */
export function listSpecPaths(prefix = '/admin/multitenancy'): string[] {
  return Object.keys(getOpenAPISpec(prefix).paths)
}
