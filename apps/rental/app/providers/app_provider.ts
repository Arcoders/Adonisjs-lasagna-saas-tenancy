import type { ApplicationService } from '@adonisjs/core/types'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  CircuitBreakerService,
  DoctorService,
  builtInChecks,
  mapTenants,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type { DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import {
  ReportExtensionRegistry,
  ReportingService,
  REPORTING_CONTRACT_VERSION,
} from '@adonisjs-lasagna/reporting'
import type { ReportExtensionFilters } from '@adonisjs-lasagna/reporting'
import { adminActionRegistry, ADMIN_CONTRACT_VERSION } from '@adonisjs-lasagna/admin'
import {
  AIProviderRegistry,
  DeepSeekProvider,
  EmbeddingProviderRegistry,
} from '@adonisjs-lasagna/ai'
import { MockAIProvider, MockEmbeddingProvider } from '@adonisjs-lasagna/ai/testing'
import { BillingService, MockStripe } from '@adonisjs-lasagna/billing'
import env from '#start/env'
import TenantRepository from '#app/repositories/tenant_repository'

export default class AppProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    this.bindContainerServices()
    await this.registerReportExtensions()
    this.registerAdminActions()
    await this.registerAiMockProviders()
    await this.injectMockStripeIfOffline()
  }

  async ready() {
    await this.registerListeners()
  }

  /**
   * Repository contract + cross-request singletons the package resolves at
   * runtime. The DoctorService carries the built-in checks plus a `fleet_health`
   * domain check that proves custom checks are pluggable.
   */
  private bindContainerServices() {
    this.app.container.bind(TENANT_REPOSITORY as any, () => new TenantRepository())
    this.app.container.singleton(CircuitBreakerService, () => new CircuitBreakerService())
    this.app.container.singleton(DoctorService, () => {
      const svc = new DoctorService()
      for (const check of builtInChecks) svc.register(check)
      svc.register({
        name: 'fleet_health',
        description: 'Domain check: confirms the fleet subsystem is reachable.',
        async run(): Promise<DiagnosisIssue[]> {
          return [{ code: 'fleet_ok', severity: 'info', message: 'Fleet subsystem healthy.' }]
        },
      })
      return svc
    })
  }

  /**
   * AI providers. The mock chat + embedding providers are always registered so
   * `/ai/chat`, `/ai/embed` and `/ai/retrieve` work offline; the chat mock emits a
   * CIN-shaped token so the `config.ai.redactOutput` DLP hook has something to
   * strip end to end. When `DEEPSEEK_API_KEY` is set (and not under the test
   * runner), the real DeepSeek chat provider is registered and becomes the
   * config default — the gateway then streams `deepseek-chat` over the same path.
   * Embeddings stay on the mock either way, so RAG retrieves over the seeded
   * mock-embedding space and feeds the matched docs to whichever model is active.
   *
   * The chat mock declares contract v2 + `capabilities.tools` because `config.ai.tools`
   * now offers the fleet tools (WS-AI-11): the gateway refuses a tool-carrying request
   * to a provider that does not advertise tool support rather than silently dropping
   * the tools, so an unversioned mock would 403 every offline chat. Declaring the
   * capability is honest — the mock tolerates `tools` on the request and `role: 'tool'`
   * turns in the history. Its script simply never calls a tool, exactly as a real model
   * may decline to; the loop is exercised for real against DeepSeek.
   */
  private async registerAiMockProviders() {
    const chat = await this.app.container.make(AIProviderRegistry)
    if (!chat.has('mock')) {
      chat.register(
        new MockAIProvider({
          name: 'mock',
          contractVersion: 2,
          tools: true,
          fragments: [
            { data: 'Your fleet has vehicles available. Ref ', tokens: 1 },
            { data: 'AB123456', tokens: 1 },
          ],
        }),
        { activate: true }
      )
    }

    // Bind the real DeepSeek chat provider when its key is present. The mirror of
    // the `config/multitenancy.ts` predicate keeps the offline test path on the
    // deterministic mock. The key is read from the environment, never hardcoded.
    const deepSeekKey = env.get('DEEPSEEK_API_KEY')
    if (deepSeekKey && env.get('NODE_ENV') !== 'test' && !chat.has('deepseek')) {
      chat.register(new DeepSeekProvider({ apiKey: deepSeekKey }), { activate: true })
    }

    const embedding = await this.app.container.make(EmbeddingProviderRegistry)
    if (!embedding.has()) embedding.register(new MockEmbeddingProvider({ dimension: 8 }))
  }

  /**
   * Offline billing: with no real Stripe key, inject MockStripe into the stripe
   * driver so checkout/portal/webhook run in memory. A real `sk_test_…`/`sk_live_…`
   * key skips this and the driver dials Stripe for real — no code change.
   */
  private async injectMockStripeIfOffline() {
    const apiKey = env.get('STRIPE_API_KEY')
    const isPlaceholder = !apiKey || apiKey.includes('placeholder')
    if (!isPlaceholder) return
    const billing = await this.app.container.make(BillingService)
    const secret = env.get('STRIPE_WEBHOOK_SECRET', 'whsec_karimoto_placeholder_secret')
    await billing.__setStripeForTests(new MockStripe(secret))
  }

  /**
   * A demo admin action (`fleet_snapshot`) and a cross-tenant report extension
   * (`fleet_utilization`). Both walk the busiest tenants and read a per-tenant
   * figure with bounded concurrency + error isolation via `mapTenants`.
   */
  private registerAdminActions() {
    if (adminActionRegistry.has('fleet_snapshot')) return
    const app = this.app
    adminActionRegistry.register({
      name: 'fleet_snapshot',
      description: 'Count vehicles across the busiest companies (bounded, error-isolated).',
      contractVersion: ADMIN_CONTRACT_VERSION,
      async execute() {
        const reporting = await app.container.make(ReportingService)
        const tenants = []
        for await (const { tenant } of reporting.iterateTenantsByUsage({})) {
          tenants.push(tenant)
          if (tenants.length >= 10) break
        }
        const { results, errors } = await mapTenants(
          tenants,
          async () => {
            // mapTenants runs this inside tenancy.run(tenant), so a TenantBaseModel
            // query routes to that company's schema. A bare db.connection() would
            // hit the template connection (search_path 'public'), where the
            // per-tenant `vehicles` table does not exist.
            const { default: Vehicle } = await import('#app/models/tenant_scoped/vehicle')
            const rows = await Vehicle.query().count('* as n')
            return Number(rows[0]?.$extras.n ?? 0)
          },
          { concurrency: 3 }
        )
        return {
          scanned: results.length,
          failed: errors.length,
          totalVehicles: results.reduce((a, r) => a + (r.value ?? 0), 0),
        }
      },
    })
  }

  private async registerReportExtensions() {
    const registry = await this.app.container.make(ReportExtensionRegistry)
    if (registry.has('fleet_utilization')) return
    const app = this.app
    registry.register({
      name: 'fleet_utilization',
      description: 'Per-company fleet size + active rentals across the busiest tenants.',
      contractVersion: REPORTING_CONTRACT_VERSION,
      async execute(filters: ReportExtensionFilters) {
        const reporting = await app.container.make(ReportingService)
        const tenants = []
        for await (const { tenant } of reporting.iterateTenantsByUsage({
          since: filters.since,
          until: filters.until,
        })) {
          tenants.push(tenant)
          if (tenants.length >= 20) break
        }
        const { results } = await mapTenants(
          tenants,
          async (tenant) => {
            // Inside tenancy.run(tenant): the tenant-scoped models route to this
            // company's schema (a bare db.connection() would hit the 'public'
            // template, where these tables do not live).
            const { default: Vehicle } = await import('#app/models/tenant_scoped/vehicle')
            const { default: Booking } = await import('#app/models/tenant_scoped/booking')
            const fleet = await Vehicle.query().count('* as n')
            const active = await Booking.query().where('status', 'active').count('* as n')
            const vehicles = Number(fleet[0]?.$extras.n ?? 0)
            const rented = Number(active[0]?.$extras.n ?? 0)
            return {
              tenant: tenant.id,
              vehicles,
              activeRentals: rented,
              utilization: vehicles > 0 ? Math.round((rented / vehicles) * 100) : 0,
            }
          },
          { concurrency: 3 }
        )
        return { companies: results.map((r) => r.value) }
      },
    })
  }

  /** Domain event listeners (booking board / metrics feed) are wired here. */
  private async registerListeners() {
    const emitter = await this.app.container.make('emitter')
    const { default: BookingBoardListener } = await import('#app/listeners/booking_board_listener')
    BookingBoardListener.register(emitter)
  }
}
