/**
 * OpenAPI 3.1 spec for the reporting dashboard + report-extension endpoints.
 * Built declaratively and rooted at `prefix` so a unit test can cross-check it
 * against the routes. Pure — imports nothing app-dependent.
 */

export interface ReportingOpenApiDocument {
  openapi: '3.1.0'
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, unknown>>
  components: { schemas: Record<string, unknown> }
}

function jsonResponse(description: string, schema?: unknown, status = 200) {
  return {
    [String(status)]: {
      description,
      ...(schema ? { content: { 'application/json': { schema } } } : {}),
    },
  }
}

const schemas = {
  ReportAggregate: {
    type: 'object',
    properties: {
      period: { type: 'string', description: 'YYYY-MM-DD start-of-period bucket' },
      totalRequests: { type: 'integer' },
      totalErrors: { type: 'integer' },
      totalBandwidthBytes: { type: 'integer' },
      activeTenants: { type: 'integer' },
      errorRate: { type: 'number', description: 'errors / requests, in [0, 1]' },
    },
  },
  TopTenantMetric: {
    type: 'object',
    properties: {
      tenantId: { type: 'string', format: 'uuid' },
      requests: { type: 'integer' },
      errors: { type: 'integer' },
      bandwidthBytes: { type: 'integer' },
      errorRate: { type: 'number' },
    },
  },
  CustomMetricBreakdown: {
    type: 'object',
    properties: { name: { type: 'string' }, total: { type: 'integer' } },
  },
  Dashboard: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        properties: {
          aggregate: { type: 'array', items: { $ref: '#/components/schemas/ReportAggregate' } },
          topTenants: { type: 'array', items: { $ref: '#/components/schemas/TopTenantMetric' } },
          customMetrics: {
            type: 'array',
            items: { $ref: '#/components/schemas/CustomMetricBreakdown' },
          },
          dataAsOf: {
            type: ['string', 'null'],
            description:
              'Latest flushed period (YYYY-MM-DD) the report reflects, or null when empty',
          },
        },
      },
    },
  },
  Error: {
    type: 'object',
    properties: { error: { type: 'string' } },
    required: ['error'],
  },
}

/**
 * Build the reporting OpenAPI spec rooted at `prefix` (default `/reporting`).
 * Every path key is prefixed, so changing `prefix` re-paths the whole document.
 */
export function getReportingOpenAPISpec(prefix = '/reporting'): ReportingOpenApiDocument {
  const base = prefix.replace(/\/$/, '') || ''

  const paths: Record<string, Record<string, unknown>> = {
    [`${base}/dashboard`]: {
      get: {
        tags: ['Reporting'],
        summary: 'Cross-tenant usage dashboard',
        parameters: [
          {
            name: 'period',
            in: 'query',
            schema: { type: 'string', enum: ['day', 'week', 'month'] },
          },
          { name: 'since', in: 'query', schema: { type: 'string', description: 'ISO YYYY-MM-DD' } },
          { name: 'until', in: 'query', schema: { type: 'string', description: 'ISO YYYY-MM-DD' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000 } },
        ],
        responses: {
          ...jsonResponse('OK', { $ref: '#/components/schemas/Dashboard' }),
          ...jsonResponse('Bad request', { $ref: '#/components/schemas/Error' }, 400),
        },
      },
    },
    [`${base}/reports/extension/{name}`]: {
      get: {
        tags: ['Reporting'],
        summary: 'Run a host-registered report extension',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          ...jsonResponse('OK', { type: 'object', properties: { data: {} } }),
          ...jsonResponse('Unknown extension', { $ref: '#/components/schemas/Error' }, 404),
        },
      },
    },
    [`${base}/openapi.json`]: {
      get: {
        tags: ['Reporting'],
        summary: 'OpenAPI 3.1 spec for the reporting API',
        responses: jsonResponse('OK', { type: 'object' }),
      },
    },
    [`${base}/docs`]: {
      get: {
        tags: ['Reporting'],
        summary: 'Swagger UI',
        responses: { 200: { description: 'HTML page' } },
      },
    },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Lasagna Reporting API',
      version: '1.0.0',
      description:
        'Cross-tenant analytics for `@adonisjs-lasagna/reporting`: usage aggregates, top-N tenants, custom metrics, and host-defined report extensions.',
    },
    paths,
    components: { schemas },
  }
}

/** Every path key in the spec, for cross-checking router registrations. */
export function listReportingSpecPaths(prefix = '/reporting'): string[] {
  return Object.keys(getReportingOpenAPISpec(prefix).paths)
}
