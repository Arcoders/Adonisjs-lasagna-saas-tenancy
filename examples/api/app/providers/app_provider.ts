import type { ApplicationService } from '@adonisjs/core/types'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  CircuitBreakerService,
  DoctorService,
  builtInChecks,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type { DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import { mapTenants } from '@adonisjs-lasagna/saas-tenancy/services'
import db from '@adonisjs/lucid/services/db'
import {
  ReportExtensionRegistry,
  ReportingService,
  REPORTING_CONTRACT_VERSION,
} from '@adonisjs-lasagna/reporting'
import type { ReportExtensionFilters } from '@adonisjs-lasagna/reporting'
import { adminActionRegistry, ADMIN_CONTRACT_VERSION } from '@adonisjs-lasagna/admin'
import { AIProviderRegistry, EmbeddingProviderRegistry } from '@adonisjs-lasagna/ai'
import { MockAIProvider, MockEmbeddingProvider } from '@adonisjs-lasagna/ai/testing'
import TenantRepository from '#app/repositories/tenant_repository'

export default class AppProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    this.bindContainerServices()
    await this.registerReportExtensions()
    this.registerAdminActions()
    await this.registerAiMockProviders()
  }

  /**
   * Register the offline mock AI providers so the demo (and the AI e2e suite) run
   * with no network. `AiProvider.register()` runs before this provider's `boot()`
   * (it is listed earlier in adonisrc), so both registries are bound and makeable
   * here. The chat mock activates as the `mock` provider named in `config.ai`; the
   * embedding mock overrides the configured default via the embedding registry so
   * `/ai/embed` and `/ai/retrieve` never dial a real embeddings endpoint.
   */
  private async registerAiMockProviders() {
    const chat = await this.app.container.make(AIProviderRegistry)
    if (!chat.has('mock'))
      chat.register(
        // Emit a fake PII token in the streamed output so the demo
        // `config.ai.redactOutput` DLP hook has something to strip end to end
        // (proven by the ai_output_redaction e2e). Normal prose is preserved; only
        // the SSN-shaped token is redacted.
        new MockAIProvider({
          name: 'mock',
          fragments: [
            { data: 'The record is ', tokens: 1 },
            { data: 'SSN-000-00-0000', tokens: 1 },
          ],
        }),
        { activate: true }
      )

    const embedding = await this.app.container.make(EmbeddingProviderRegistry)
    if (!embedding.has()) embedding.register(new MockEmbeddingProvider({ dimension: 8 }))
  }

  /**
   * Register a demo admin action so `POST /admin/multitenancy/actions/demo_ping`
   * has something to run. The registry is a module-level singleton (admin ships
   * no provider), so it's safe to populate here in `boot()`.
   */
  private registerAdminActions() {
    if (adminActionRegistry.has('demo_ping')) return
    adminActionRegistry.register({
      name: 'demo_ping',
      description: 'A trivial demo admin action proving the dispatch route is wired.',
      contractVersion: ADMIN_CONTRACT_VERSION,
      async execute(ctx) {
        return { ok: true, at: ctx.request.url() }
      },
    })
  }

  /**
   * Register a demo report extension so `tenant:report:generate --extension=…`
   * and `GET /admin/reporting/reports/extension/:name` have something to run.
   * The reporting provider binds the registry singleton in its `register()`;
   * this provider boots after it.
   */
  private async registerReportExtensions() {
    const registry = await this.app.container.make(ReportExtensionRegistry)
    if (registry.has('demo_summary')) return
    registry.register({
      name: 'demo_summary',
      description: 'A trivial demo report extension proving the registry is wired.',
      contractVersion: REPORTING_CONTRACT_VERSION,
      async execute(filters: ReportExtensionFilters) {
        return { ok: true, window: filters }
      },
    })

    // Worked fan-out example: walk the busiest tenants (backoffice, no scope),
    // then read a per-tenant-schema figure for each with bounded concurrency and
    // error isolation via `mapTenants`. This is the documented escape hatch for
    // extensions that must enter tenant schemas.
    const app = this.app
    registry.register({
      name: 'slow_tenants',
      description: 'Per-tenant schema probe across the busiest tenants (bounded, error-isolated).',
      contractVersion: REPORTING_CONTRACT_VERSION,
      async execute(filters: ReportExtensionFilters) {
        const reporting = await app.container.make(ReportingService)
        const tenants = []
        // iterateTenantsByUsage only reads the window; map the string filters to it.
        for await (const { tenant } of reporting.iterateTenantsByUsage({
          since: filters.since,
          until: filters.until,
        })) {
          tenants.push(tenant)
          if (tenants.length >= 5) break // demo: cap at the top 5 busiest
        }
        const { results, errors } = await mapTenants(
          tenants,
          async () => {
            const r = await db.connection().rawQuery('SELECT current_schema() AS schema')
            return (r.rows?.[0]?.schema ?? null) as string | null
          },
          { concurrency: 3 }
        )
        return {
          scanned: results.length,
          failed: errors.length,
          schemas: results.map((r) => r.value),
        }
      },
    })
  }

  /**
   * `ready` runs after `boot`, so the emitter (resolved via `app.booted()`
   * in `@adonisjs/core/services/emitter`) is guaranteed to exist by now.
   * Registering listeners earlier would crash with "cannot read 'on' of
   * undefined".
   */
  async ready() {
    await this.registerListeners()
  }

  /**
   * Repository contract + singletons the package looks up at runtime.
   *
   * - `TENANT_REPOSITORY` is required for `request.tenant()` and the package's
   *   own services (admin controller, doctor checks, etc.).
   * - `CircuitBreakerService` must be a singleton so the same breaker is
   *   reused across requests for the same tenant.
   * - `DoctorService` is a singleton with the 7 built-in checks plus a
   *   demo-only marker check that proves custom checks are pluggable.
   */
  private bindContainerServices() {
    // The TENANT_REPOSITORY symbol is typed as `unique symbol` by the package
    // but the container's `bind` overloads accept untyped Symbol values via
    // its any-keyed overload. Cast at the binding site only.
    this.app.container.bind(TENANT_REPOSITORY as any, () => new TenantRepository())

    this.app.container.singleton(CircuitBreakerService, () => new CircuitBreakerService())

    this.app.container.singleton(DoctorService, () => {
      const svc = new DoctorService()
      for (const check of builtInChecks) svc.register(check)
      svc.register({
        name: 'demo_marker_check',
        description: 'Demo-only check that always succeeds — proves custom checks work.',
        async run(): Promise<DiagnosisIssue[]> {
          return [
            {
              code: 'demo_marker',
              severity: 'info',
              message: 'Demo check ran. All good.',
            },
          ]
        },
      })
      return svc
    })
  }

  /**
   * Wire app-side listeners onto the emitter. Lifted from `start/routes.ts`
   * so routing concerns stay decoupled from side-effects. We resolve the
   * emitter from the container (rather than importing the magic singleton)
   * to keep the lifecycle ordering explicit.
   */
  private async registerListeners() {
    const emitter = await this.app.container.make('emitter')
    const [
      { default: AuditListener },
      { default: TenantWelcomeListener },
      { default: BillingDeadLetterListener },
    ] = await Promise.all([
      import('#app/listeners/audit_listener'),
      import('#app/listeners/tenant_welcome_listener'),
      import('#app/listeners/billing_dead_letter_listener'),
    ])
    AuditListener.register(emitter)
    TenantWelcomeListener.register(emitter)
    BillingDeadLetterListener.register(emitter)
  }
}
