import type { ApplicationService } from '@adonisjs/core/types'
import {
  assertSatelliteApiCompatAtBoot,
  type SatelliteProviderConstructor,
  type SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import {
  CircuitBreakerService,
  ExtensionTimeoutError,
  QuotaService,
  executeExtension,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { assertAiConfig } from '../src/validate_config.js'
import type { MultitenancyConfigWithAi } from '../src/define_config.js'
import AIProviderRegistry from '../src/services/ai_provider_registry.js'
import StreamExtensionService from '../src/gateway/stream_extension.js'

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
  constructor(protected app: ApplicationService) {}

  register() {
    // Stateful, Map-backed: resolved via container.make, never new-ed ad hoc.
    this.app.container.singleton(AIProviderRegistry, () => new AIProviderRegistry())
    // The streaming integrator resolves its quota + breaker seams from the
    // container, never new-ing them (the platform rule).
    this.app.container.singleton(StreamExtensionService, async (resolver) => {
      const quota = await resolver.make(QuotaService)
      const breaker = await resolver.make(CircuitBreakerService)
      return new StreamExtensionService({
        quota,
        breaker,
        runExtension: executeExtension,
        isTimeoutError: (error) => error instanceof ExtensionTimeoutError,
      })
    })
  }

  boot() {
    // Runtime ABI backstop (see scripts/check-abi-boot-assertion.mjs; satelliteApi
    // mirrors package.json#lasagnaSatellite). Fail fast on a core too old.
    assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, '@adonisjs-lasagna/ai')

    const config = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')
    assertAiConfig(config?.ai)
  }
}

// Compile-time ABI pin: fail the build if the provider drifts from the public
// satellite constructor contract (same guard billing / reporting / backup use).
const _satelliteAbiPin: SatelliteProviderConstructor = AiProvider
void _satelliteAbiPin
