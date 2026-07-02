import type { ApplicationService } from '@adonisjs/core/types'
import {
  assertSatelliteApiCompatAtBoot,
  type SatelliteProviderConstructor,
  type SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import {
  CircuitBreakerService,
  DoctorService,
  ExtensionTimeoutError,
  MetricsService,
  QuotaService,
  TelemetryService,
  cacheFor,
  consumeRateLimit,
  executeExtension,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { assertAiConfig } from '../src/validate_config.js'
import type { AiConfig, MultitenancyConfigWithAi } from '../src/define_config.js'
import { DEFAULT_AI_PROVIDER } from '../src/constants.js'
import AIProviderRegistry from '../src/services/ai_provider_registry.js'
import AiRateLimiter from '../src/services/ai_rate_limiter.js'
import StreamExtensionService from '../src/gateway/stream_extension.js'
import TenantLivenessWatcher, {
  wireAiTenantLiveness,
} from '../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyStore,
} from '../src/gateway/idempotency.js'
import { aiMembershipGateCheck } from '../src/services/ai_membership_gate_check.js'
import { setAiGuardMetricSink } from '../src/isthmus/ai_guard_audit.js'
import ClaudeProvider from '../src/providers/claude_provider.js'
import { DeepSeekProvider, KimiProvider } from '../src/providers/openai_compatible_provider.js'
import type { AIProviderContract } from '../src/types/ai_provider_contract.js'

/**
 * Provider for `@adonisjs-lasagna/ai`. Register it in the host's `adonisrc.ts`
 * alongside the core `MultitenancyProvider` (the configure hook does this for
 * you via `registerSatelliteInRcFile`).
 *
 * It obeys the platform rules: core is resolved through `app.container.make`,
 * never `new`-ed, and the dependency only goes satellite to core. `boot()`
 * validates the `ai` config block eagerly so a bad shape fails at startup rather
 * than at the first stream. The streaming service, provider registry and
 * providers bind here as they land in later commits.
 */
export default class AiProvider implements SatelliteProviderContract {
  #teardownLiveness?: () => void

  constructor(protected app: ApplicationService) {}

  register() {
    // Stateful, Map-backed: resolved via container.make, never new-ed ad hoc.
    this.app.container.singleton(AIProviderRegistry, () => new AIProviderRegistry())
    // Live stream abort handles per tenant (G11). Stateful and cross-request,
    // so it is a container singleton like the registry.
    this.app.container.singleton(TenantLivenessWatcher, () => new TenantLivenessWatcher())
    // Idempotent replay over the kernel's per-tenant cache namespace. The
    // /services value import stays in THIS file (the eager-redis rule); the
    // gateway module only sees the narrow injected store seam.
    this.app.container.singleton(AiIdempotencyService, () => {
      const store: AiIdempotencyStore = {
        async get(tenantId, key) {
          return await cacheFor(tenantId).get<string>({ key })
        },
        async set(tenantId, key, value, ttlMs) {
          await cacheFor(tenantId).set({ key, value, ttl: ttlMs })
        },
      }
      const ai = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      return new AiIdempotencyService({
        store,
        macKey: deriveAiIdempotencyMacKey(requireAppKey()),
        ttlMs: ai?.idempotencyTtlMs,
      })
    })
    // The per-key request rate limiter (threat #4). Its redis-backed consumer is
    // built HERE (the one sanctioned toucher of the eager core barrel); the
    // gateway sees only the injected AiRateLimiter. Redis is resolved through the
    // app container's `'redis'` binding (the same RedisManager singleton
    // `@adonisjs/redis/services/main` returns), so the satellite adds no direct
    // redis dependency and shares the host's single connection manager.
    this.app.container.singleton(AiRateLimiter, () => {
      const ai = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const getRedis = () => this.app.container.make('redis')
      return new AiRateLimiter({
        consume: (args) => consumeRateLimit({ getRedis, ...args }),
        policy: ai?.rateLimit,
      })
    })
    // The streaming integrator resolves its quota + breaker seams from the
    // container, never new-ing them (the platform rule).
    this.app.container.singleton(StreamExtensionService, async (resolver) => {
      const quota = await resolver.make(QuotaService)
      const breaker = await resolver.make(CircuitBreakerService)
      const metrics = await resolver.make(MetricsService)
      return new StreamExtensionService({
        quota,
        breaker,
        runExtension: executeExtension,
        isTimeoutError: (error) => error instanceof ExtensionTimeoutError,
        emitMetric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        withSpan: (name, attrs, fn) => TelemetryService.withSpan(name, attrs, fn),
      })
    })
  }

  async boot() {
    // Runtime ABI backstop (see scripts/check-abi-boot-assertion.mjs; satelliteApi
    // mirrors package.json#lasagnaSatellite). Fail fast on a core too old.
    assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, '@adonisjs-lasagna/ai')

    const config = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')
    assertAiConfig(config?.ai)
    await this.#registerBuiltinProviders(config?.ai)

    // Keep the AI authorization posture visible: the same wording as the
    // mount-time warning, surfaced by `tenant:doctor` even before any route
    // file runs (the backup satellite's boot-time registration pattern).
    const doctor = await this.app.container.make(DoctorService)
    doctor.register(
      aiMembershipGateCheck(() => this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai)
    )
  }

  async ready() {
    // Emitter subscriptions belong in ready(), resolved via container.make:
    // the emitter service module is unassigned until the booted hooks run
    // (the kernel's documented wireResolutionCacheInvalidation regression).
    const emitter = await this.app.container.make('emitter')
    const watcher = await this.app.container.make(TenantLivenessWatcher)
    this.#teardownLiveness = wireAiTenantLiveness(emitter, watcher)

    // Bridge tenantful guard trips to the per-tenant integer-metric rail.
    const metrics = await this.app.container.make(MetricsService)
    setAiGuardMetricSink((tenantId, name, value) => metrics.emitMetric(tenantId, name, value))
  }

  async shutdown() {
    this.#teardownLiveness?.()
    this.#teardownLiveness = undefined
    setAiGuardMetricSink(undefined)
  }

  /**
   * Register the built-in providers that are allow-listed and configured. An
   * unconfigured provider is simply not registered, so it can never be silently
   * selected; a host registers custom / BYOK providers in its own provider.
   */
  async #registerBuiltinProviders(ai: AiConfig | undefined): Promise<void> {
    if (!ai) return
    const registry = await this.app.container.make(AIProviderRegistry)
    const activeName = ai.defaultProvider ?? DEFAULT_AI_PROVIDER
    for (const name of ai.allowedProviders) {
      const provider = buildBuiltinProvider(name, ai)
      if (provider) registry.register(provider, { activate: provider.name === activeName })
    }
  }
}

/** The kernel's own APP_KEY source (utils/crypto.ts requireAppKey pattern). */
function requireAppKey(): string {
  const appKey = process.env.APP_KEY
  if (!appKey) {
    throw new Error('[ai] APP_KEY is not set; the idempotency MAC key derives from it')
  }
  return appKey
}

/** Construct a built-in provider from its config block; custom names are host-registered. */
function buildBuiltinProvider(name: string, ai: AiConfig): AIProviderContract | undefined {
  if (name === 'claude' && ai.claude) return new ClaudeProvider(ai.claude)
  if (name === 'deepseek' && ai.deepseek) return new DeepSeekProvider(ai.deepseek)
  if (name === 'kimi' && ai.kimi) return new KimiProvider(ai.kimi)
  return undefined
}

// Compile-time ABI pin: fail the build if the provider drifts from the public
// satellite constructor contract (same guard billing / reporting / backup use).
const _satelliteAbiPin: SatelliteProviderConstructor = AiProvider
void _satelliteAbiPin
