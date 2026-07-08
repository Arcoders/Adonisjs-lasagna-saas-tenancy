import type { ApplicationService } from '@adonisjs/core/types'
import {
  assertSatelliteApiCompatAtBoot,
  resolveLucidDb,
  type SatelliteProviderConstructor,
  type SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import {
  AuditLogDestinationRegistry,
  AuditLogService,
  CircuitBreakerService,
  ComplianceReportService,
  DoctorService,
  ExtensionTimeoutError,
  HookRegistry,
  MetricsService,
  QuotaService,
  TelemetryService,
  cacheFor,
  consumeRateLimit,
  executeExtension,
  getActiveDriver,
  pgvectorExtensionCheck,
  provisionVectorExtension,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantDeleted, TenantAnonymized } from '@adonisjs-lasagna/saas-tenancy/events'
import { safeFetch } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import {
  tenancy,
  writeSecret,
  readSecret,
  decryptWithAppKey,
  SECRET_CLASS,
} from '@adonisjs-lasagna/saas-tenancy'
import { assertAiConfig } from '../src/validate_config.js'
import type { AiConfig, MultitenancyConfigWithAi } from '../src/define_config.js'
import { DEFAULT_AI_PROVIDER, DEFAULT_EMBEDDING_DIM } from '../src/constants.js'
import AIProviderRegistry from '../src/services/ai_provider_registry.js'
import EmbeddingProviderRegistry from '../src/services/embedding_provider_registry.js'
import AiRateLimiter from '../src/services/ai_rate_limiter.js'
import VectorStoreService, { type VectorDb } from '../src/services/vector_store_service.js'
import EmbeddingIngestionService from '../src/services/embedding_ingestion_service.js'
import RetrievalService from '../src/services/retrieval_service.js'
import AiAuditWriter, { type AuditDb } from '../src/services/ai_audit_writer.js'
import {
  PgChatAuditSink,
  PgEmbeddingAuditSink,
  PgRetrievalAuditSink,
} from '../src/gateway/audit_sinks.js'
import AIException from '../src/exceptions/ai_exception.js'
import StreamExtensionService from '../src/gateway/stream_extension.js'
import TenantLivenessWatcher, {
  wireAiTenantLiveness,
} from '../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyStore,
} from '../src/gateway/idempotency.js'
import ConversationMemoryService, {
  deriveMemoryMacKey,
} from '../src/services/conversation_memory_service.js'
import AiComplianceService from '../src/services/ai_compliance_service.js'
import {
  aiDataResidencyControl,
  aiEmbeddingRetentionControl,
  aiRightToErasureControl,
} from '../src/services/ai_compliance_controls.js'
import { aiComplianceCheck } from '../src/services/ai_compliance_check.js'
import { aiMembershipGateCheck } from '../src/services/ai_membership_gate_check.js'
import { aiBudgetCheck, aiTokensBudgetPosture } from '../src/services/ai_budget_check.js'
import {
  aiRetrievalGateCheck,
  aiRetrievalGatePosture,
} from '../src/services/ai_retrieval_gate_check.js'
import { aiAuditCheck } from '../src/services/ai_audit_check.js'
import { aiMemoryCheck } from '../src/services/ai_memory_check.js'
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
  #offTenantDeleted?: () => void
  #offTenantAnonymized?: () => void

  constructor(protected app: ApplicationService) {}

  register() {
    // Stateful, Map-backed: resolved via container.make, never new-ed ad hoc.
    this.app.container.singleton(AIProviderRegistry, () => new AIProviderRegistry())
    // The embedding-provider override registry (WS-AI-8, 2A): a host registers its
    // own embedding provider (offline mock / local dev) and it supersedes the
    // configured default. Resolved at make-time by the ingestion/retrieval
    // singletons, so a late (boot-time) host registration always wins.
    this.app.container.singleton(EmbeddingProviderRegistry, () => new EmbeddingProviderRegistry())
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
    // Conversation memory (WS-AI-4, I2). Encrypted at rest through the kernel's
    // fail-closed, domain-separated secret seam (writeSecret/readSecret bound to
    // the 'aiConversationMemory' class), stored as an atomic Redis LIST via the
    // same `'redis'` binding the rate limiter uses. The enc_v2 write/read pass in
    // as narrow injected deps so the gateway module never value-imports core; the
    // OLD_APP_KEY grace read (dual-key rotation) is wired only when that env is
    // set. Metrics + a metadata-only warn make a persist/decrypt failure observable.
    this.app.container.singleton(ConversationMemoryService, async (resolver) => {
      const ai = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const metrics = await resolver.make(MetricsService)
      const logger = await resolver.make('logger')
      const currentAppKey = requireAppKey()
      const oldAppKey = process.env.OLD_APP_KEY
      return new ConversationMemoryService({
        getRedis: () => this.app.container.make('redis'),
        macKey: deriveMemoryMacKey(currentAppKey),
        encryptMemory: (plain) => writeSecret(plain, 'aiConversationMemory'),
        decryptMemory: (cipher) => readSecret(cipher, 'aiConversationMemory'),
        decryptMemoryPrevious:
          oldAppKey && oldAppKey !== currentAppKey
            ? (cipher) => decryptWithAppKey(cipher, oldAppKey, SECRET_CLASS.aiConversationMemory)
            : undefined,
        config: ai?.memory,
        metric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        warn: (message) => logger.warn(message),
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
    // The per-tenant vector store (WS-AI-3). It resolves placement from the active
    // driver and runs raw SQL on the tenant connection, so it takes the driver,
    // the Lucid db (via the `'lucid.db'` container alias, like `'redis'`, so no
    // direct lucid dependency), and the active tenancy scope id (the satellite
    // ContextSeal that raw SQL bypasses). Stateful only through the db: a singleton.
    this.app.container.singleton(VectorStoreService, () => {
      const ai = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      return new VectorStoreService({
        getDriver: () => getActiveDriver(),
        getDb: async () => (await resolveLucidDb(this.app)) as unknown as VectorDb,
        activeScopeTenantId: () => tenancy.currentId(),
        dimension: ai?.embedding?.dimension ?? DEFAULT_EMBEDDING_DIM,
        purgeStatementTimeoutMs: ai?.purgeStatementTimeoutMs,
      })
    })
    // The ingestion orchestrator. It injects the store, the kernel quota
    // (reserve/settle/release/getLimit), the SSRF-pinned fetch, and the integer
    // metric sink; the embedding provider is built from `config.ai.embedding`.
    this.app.container.singleton(EmbeddingIngestionService, async (resolver) => {
      const store = await resolver.make(VectorStoreService)
      const quota = await resolver.make(QuotaService)
      const metrics = await resolver.make(MetricsService)
      const embedding = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai?.embedding
      if (!embedding) {
        throw new AIException(
          'config_missing',
          'config.ai.embedding is required to use the vector store'
        )
      }
      return new EmbeddingIngestionService({
        store,
        provider: (await resolver.make(EmbeddingProviderRegistry)).resolve(embedding),
        quota,
        fetch: safeFetch,
        emitMetric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        config: embedding,
      })
    })
    // The retrieval (RAG read) orchestrator (WS-AI-5). Same store + quota +
    // embedding provider as ingestion (so the query vector matches the corpus);
    // a read writes no rows, so it takes no `getLimit`. Bound as a singleton
    // like the ingestion service; the /retrieve and RAG-into-chat paths resolve
    // it via container.make.
    this.app.container.singleton(RetrievalService, async (resolver) => {
      const store = await resolver.make(VectorStoreService)
      const quota = await resolver.make(QuotaService)
      const metrics = await resolver.make(MetricsService)
      const embedding = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai?.embedding
      if (!embedding) {
        throw new AIException('config_missing', 'config.ai.embedding is required to use retrieval')
      }
      return new RetrievalService({
        store,
        provider: (await resolver.make(EmbeddingProviderRegistry)).resolve(embedding),
        quota,
        emitMetric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        config: embedding,
      })
    })
    // The append-only AI audit (WS-AI-7, I5). On by default; a host opts out with
    // config.ai.audit.enabled = false. The writer resolves the shared backoffice
    // connection (via the `'lucid.db'` alias, like the vector store) + the active
    // tenancy scope (the ContextSeal raw SQL bypasses); the three sinks map the
    // frozen choke-point events onto it. Singletons, stateful only through the db.
    const audit = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai?.audit
    if (audit?.enabled !== false) {
      this.app.container.singleton(AiAuditWriter, () => {
        const { connectionName, schemaName } = this.#backofficeWiring()
        return new AiAuditWriter({
          getDb: async () => (await resolveLucidDb(this.app)) as unknown as AuditDb,
          connectionName,
          schemaName,
          activeScopeTenantId: () => tenancy.currentId(),
          // External anchoring (#6): reuse the kernel audit destination registry
          // the operator already configures, so kernel + AI audit share one
          // SIEM/WORM stream. Best-effort, after the canonical commit.
          getDestinations: () => this.app.container.make(AuditLogDestinationRegistry),
          runExtension: executeExtension,
        })
      })
      this.app.container.singleton(
        PgChatAuditSink,
        async (resolver) => new PgChatAuditSink(await resolver.make(AiAuditWriter))
      )
      this.app.container.singleton(
        PgEmbeddingAuditSink,
        async (resolver) => new PgEmbeddingAuditSink(await resolver.make(AiAuditWriter))
      )
      this.app.container.singleton(
        PgRetrievalAuditSink,
        async (resolver) => new PgRetrievalAuditSink(await resolver.make(AiAuditWriter))
      )
    }
    // The WS-AI-9 compliance orchestrator. Composes the purge seams (memory +
    // vector + idempotency epoch) into GDPR-grade erasure, records the admin
    // action via the KERNEL audit best-effort, and runs vector work inside
    // `tenancy.run` so the raw-SQL ContextSeal actively protects. Stateful only
    // through its injected seams: a container singleton.
    this.app.container.singleton(AiComplianceService, async (resolver) => {
      const ai = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const memory = await resolver.make(ConversationMemoryService)
      const vectorStore = await resolver.make(VectorStoreService)
      const idempotency = await resolver.make(AiIdempotencyService)
      const metrics = await resolver.make(MetricsService)
      const logger = await resolver.make('logger')
      const auditEnabled = ai?.audit?.enabled !== false
      return new AiComplianceService({
        memory,
        vectorStore,
        idempotency,
        // Bind the tenant as the active scope so the vector ContextSeal protects (E16).
        runScoped: (tenant, fn) => tenancy.run(tenant, fn),
        embeddingsEnabled: ai?.embedding !== undefined,
        getRedis: () => this.app.container.make('redis'),
        // Best-effort kernel audit of the purge, alongside gdpr.anonymize / destroy (E20).
        auditLog: async (options) => (await this.app.container.make(AuditLogService)).log(options),
        // Full AI-audit-chain verify only under --verify-chain (E10), and only when audit is on.
        verifyAuditChain: auditEnabled
          ? async (tenantId) => (await this.app.container.make(AiAuditWriter)).verify(tenantId)
          : undefined,
        metric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        warn: (message) => logger.warn(message),
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
    // Keep the cost-metering posture visible too: an unbudgeted aiTokens quota
    // leaves the endpoint unmetered (denial of wallet). The check reports the
    // live posture; the boot warning fires only for the genuinely-unbudgeted,
    // not-acknowledged, non-dynamic case (a static read cannot see a dynamic
    // per-tenant budget, so it must not hard-fail).
    doctor.register(
      aiBudgetCheck(() => this.app.config.get<MultitenancyConfigWithAi>('multitenancy'))
    )
    // Keep the retrieval authorization posture visible too (WS-AI-5, G2): with
    // embeddings configured but no per-user document ACL wired, retrieval is
    // fail-closed (refused) until the host wires retrievalFilter or acknowledges
    // the tenant-wide posture. The check always reports the live posture; the boot
    // warning fires only for the refused case (see aiRetrievalGatePosture).
    doctor.register(
      aiRetrievalGateCheck(() => this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai)
    )
    // Keep the audit posture visible (WS-AI-7): audit is fail-closed and on by
    // default, so an un-provisioned backoffice.ai_audit_logs table would 503 every
    // AI request at runtime. The ai_audit check probes the table (and the app
    // role) at diagnosis time; a config-only boot warning could not see the table.
    doctor.register(
      aiAuditCheck({
        getAiConfig: () => this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai,
        getDb: async () => (await resolveLucidDb(this.app)) as unknown as AuditDb,
        ...this.#backofficeWiring(),
      })
    )
    // Keep the conversation-memory posture visible (WS-AI-4, I2): memory binds a
    // session to the resolved principal, so an enabled-but-no-principal memory is
    // inert (stateless). The check reports the live posture; it is info-only, so
    // there is no boot warning.
    doctor.register(
      aiMemoryCheck(() => this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai)
    )
    // Keep the WS-AI-9 purge posture visible (read-only): Redis reachability for
    // memory/cache erasure + a keyPrefix note. It never bumps the epoch.
    doctor.register(
      aiComplianceCheck({
        getAiConfig: () => this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai,
        getRedis: () => this.app.container.make('redis'),
      })
    )
    // Register the AI compliance posture controls (WS-AI-9) into the shared
    // ComplianceReportService, so `tenant:compliance:report` surfaces AI residency,
    // right-to-erasure, and the embeddings-survive-anonymize transparency (E24).
    if (config?.ai) {
      const compliance = await this.app.container.make(ComplianceReportService)
      compliance.register(aiDataResidencyControl)
      compliance.register(aiRightToErasureControl)
      if (config.ai.embedding) compliance.register(aiEmbeddingRetentionControl)
    }
    if (config?.ai) {
      const posture = aiTokensBudgetPosture(config)
      if (posture?.severity === 'warn') {
        const logger = await this.app.container.make('logger')
        logger.warn(`[ai] ${posture.message}`)
      }
      const retrievalPosture = aiRetrievalGatePosture(config.ai)
      if (retrievalPosture?.severity === 'warn') {
        const logger = await this.app.container.make('logger')
        logger.warn(`[ai] ${retrievalPosture.message}`)
      }
    }

    // The vector store (WS-AI-3) is opt-in: only a host that configures embeddings
    // pays for the pgvector posture check and the per-tenant provisioning hook.
    if (config?.ai?.embedding) {
      // Surface where embeddings live + that the app role is not a superuser (G14).
      doctor.register(pgvectorExtensionCheck)
      // database-pg only: install pgvector in a NEW tenant's database at
      // provision time, BEFORE its separate `tenant:migrate` runs the embeddings
      // migration. Rides the existing after:provision hook (no core change); the
      // extension is created under the privileged provision connection, never the
      // app role. schema-pg / rowscope share one database, provisioned once via
      // `tenant:vector:provision`, so the hook no-ops for them.
      const hooks = await this.app.container.make(HookRegistry)
      hooks.after('provision', async ({ tenant }) => {
        const driver = await getActiveDriver()
        if (driver.name !== 'database-pg') return
        // provisionVectorExtension swallows a per-database CREATE EXTENSION
        // failure into a `failed` count (the install run continues), so pass a
        // logger and inspect the summary: a provision-time failure must not be
        // silent. It stays fail-closed downstream (the embeddings migration
        // hard-fails on the missing `vector` type and the pgvector doctor check
        // flags the tenant), but the operator should see it here, not only later.
        const logger = await this.app.container.make('logger')
        const summary = await provisionVectorExtension({
          tenantIds: [tenant.id],
          logger: {
            info: (m) => logger.info(`[ai] ${m}`),
            warning: (m) => logger.warn(`[ai] ${m}`),
          },
        })
        if (summary.failed > 0) {
          logger.error(
            `[ai] pgvector provisioning failed for new tenant ${tenant.id}; its embeddings migration ` +
              `will fail until the vector extension is installed (check the provision role's CREATE privilege).`
          )
        }
      })
    }
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

    // WS-AI-9 auto-purge: erase a tenant's Redis-resident AI data (cache epoch +
    // conversation memory) when core destroys or anonymizes it, reusing core's
    // own lifecycle events rather than a parallel flow. On destroy the schema is
    // already dropped (so no vector call); on anonymize embeddings are kept by
    // design (decision 1). The handlers are NON-throwing (the core command has
    // already committed) and emit `guard.ai_auto_purge_failed` + a metric on
    // failure, so a silent GDPR erasure is impossible (E6/E19/E24).
    if (this.app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai) {
      const compliance = await this.app.container.make(AiComplianceService)
      this.#offTenantDeleted = emitter.on(TenantDeleted, async (event) => {
        await compliance.autoPurge(event.tenant, 'tenant_deleted')
      })
      this.#offTenantAnonymized = emitter.on(TenantAnonymized, async (event) => {
        await compliance.autoPurge(event.tenant, 'tenant_anonymized')
      })
    }
  }

  async shutdown() {
    this.#teardownLiveness?.()
    this.#teardownLiveness = undefined
    this.#offTenantDeleted?.()
    this.#offTenantDeleted = undefined
    this.#offTenantAnonymized?.()
    this.#offTenantAnonymized = undefined
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

  /**
   * The shared backoffice connection + schema the AI audit writer and the ai_audit
   * doctor probe target. Read from the multitenancy config (never a hardcoded
   * 'backoffice' literal) so a host that renames the backoffice schema/connection is
   * honored and the fail-closed audit writer does not 503 every AI request. Reads the
   * config repository, which is populated for both register() and boot() — unlike
   * core's getConfig() singleton, seeded only in core's boot(), which runs after AI's
   * register().
   */
  #backofficeWiring(): { connectionName: string; schemaName: string } {
    const mt = this.app.config.get<MultitenancyConfigWithAi>('multitenancy')
    const connectionName = mt?.backofficeConnectionName
    const schemaName = mt?.backofficeSchemaName
    if (!connectionName || !schemaName) {
      throw new AIException(
        'config_missing',
        'multitenancy.backofficeConnectionName and multitenancy.backofficeSchemaName are ' +
          'required to wire the AI audit trail.'
      )
    }
    return { connectionName, schemaName }
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
