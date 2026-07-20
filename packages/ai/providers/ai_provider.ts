import type { ApplicationService } from '@adonisjs/core/types'
import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { resolveLucidDb } from '@adonisjs-lasagna/saas-tenancy/sdk'
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
  ResilienceService,
  TelemetryService,
  cacheFor,
  consumeRateLimit,
  executeExtension,
  getActiveDriver,
  pgvectorExtensionCheck,
  provisionVectorExtension,
} from '@adonisjs-lasagna/saas-tenancy/services'
import {
  TenantDeleted,
  TenantAnonymized,
  IsthmusGuardTripped,
} from '@adonisjs-lasagna/saas-tenancy/events'
import type { AuditLogEntry } from '@adonisjs-lasagna/saas-tenancy/services'
import { randomUUID } from 'node:crypto'
import { safeFetch } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import { tenancy, writeSecret, readSecret, SECRET_CLASS } from '@adonisjs-lasagna/saas-tenancy'
import { decryptWithAppKey } from '@adonisjs-lasagna/saas-tenancy/internal'
import { assertAiConfig, failAiConfig } from '../src/validate_config.js'
import type { AiConfig, MultitenancyConfigWithAi } from '../src/define_config.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  AI_EMBEDDINGS_DEK_CATEGORY,
  AI_MEMORY_DEK_CATEGORY,
  AI_MEMORY_DEK_UNAVAILABLE_METRIC,
  DEFAULT_AI_MEMORY_ENCRYPTION,
  DEFAULT_AI_PROVIDER,
  DEFAULT_EMBEDDING_DIM,
} from '../src/constants.js'
import AIProviderRegistry from '../src/services/ai_provider_registry.js'
import EmbeddingProviderRegistry from '../src/services/embedding_provider_registry.js'
import AiRateLimiter from '../src/services/ai_rate_limiter.js'
import VectorStoreService, {
  type VectorDb,
  type VectorStoreDeps,
} from '../src/services/vector_store_service.js'
import EmbeddingIngestionService from '../src/services/embedding_ingestion_service.js'
import RetrievalService from '../src/services/retrieval_service.js'
import AiAuditWriter, { type AuditDb } from '../src/services/ai_audit_writer.js'
import AiAuditReader from '../src/services/ai_audit_reader.js'
import AiAuditAnomalyWatcher, {
  wireAiAuditAnomalyWatcher,
} from '../src/services/ai_audit_anomaly_watcher.js'
import { AI_AUDIT_ANCHOR_TIMEOUT_MS } from '../src/constants.js'
import type { AIAnomalySummary } from '../src/define_config.js'
import AiActionLedger, { type ActionLedgerDb } from '../src/services/action_ledger.js'
import { deriveAiToolConfirmationMacKey } from '../src/gateway/tool_confirmation.js'
import {
  PgChatAuditSink,
  PgEmbeddingAuditSink,
  PgRetrievalAuditSink,
  PgToolAuditSink,
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
  type ConversationMemoryDeps,
} from '../src/services/conversation_memory_service.js'
import AiComplianceService from '../src/services/ai_compliance_service.js'
import ToolExecutorService from '../src/services/tool_executor.js'
import {
  aiDataResidencyControl,
  aiEmbeddingRetentionControl,
  aiRightToErasureControl,
} from '../src/services/ai_compliance_controls.js'
import { aiComplianceCheck } from '../src/services/ai_compliance_check.js'
import { aiMembershipGateCheck } from '../src/services/ai_membership_gate_check.js'
import { aiBudgetCheck, assertAiTokensBudgetOrAbort } from '../src/services/ai_budget_check.js'
import {
  aiRetrievalGateCheck,
  aiRetrievalGatePosture,
} from '../src/services/ai_retrieval_gate_check.js'
import { aiAuditCheck } from '../src/services/ai_audit_check.js'
import { aiInjectionCheck } from '../src/services/ai_injection_check.js'
import { aiMemoryCheck } from '../src/services/ai_memory_check.js'
import { aiToolsCheck, aiToolsPosture } from '../src/services/ai_tools_check.js'
import { setAiGuardMetricSink } from '../src/isthmus/ai_guard_audit.js'
import ClaudeProvider from '../src/providers/claude_provider.js'
import { DeepSeekProvider, KimiProvider } from '../src/providers/openai_compatible_provider.js'
import type { AIProviderContract } from '../src/types/ai_provider_contract.js'

/**
 * Provider for `@adonisjs-lasagna/ai`, built with the {@link definePlugin} facade.
 * Register it in the host's `adonisrc.ts` alongside the core `MultitenancyProvider`
 * (the configure hook does this for you via `registerSatelliteInRcFile`).
 *
 * It obeys the platform rules: core is resolved through `app.container.make`, never
 * `new`-ed, and the dependency only goes satellite to core. The facade wires the
 * ABI backstops (Satellite ABI + plugin-API contract) inside its own `boot()`, so
 * this file declares only what AI does:
 *  - `bind` binds the provider registry, the streaming spine, the vector store,
 *    the audit writer + sinks, memory, idempotency, rate limiter, and the
 *    compliance orchestrator (this is `register()`).
 *  - `boot` validates the `ai` config block eagerly, registers the built-in
 *    providers, and registers the doctor/compliance posture checks + the pgvector
 *    provisioning hook.
 *  - `ready` subscribes the liveness + auto-purge emitter handlers and installs
 *    the guard metric sink (the emitter is fully wired only in ready()).
 *  - `shutdown` tears those subscriptions + the metric sink back down.
 *
 * The emitter-teardown handles live in provider-lifetime module variables below;
 * AdonisJS constructs exactly one provider per app, so they are equivalent to the
 * instance fields the raw provider used, shared between `ready` and `shutdown`.
 */
let teardownLiveness: (() => void) | undefined
let offTenantDeleted: (() => void) | undefined
let offTenantAnonymized: (() => void) | undefined
let offAnomalyWatcher: (() => void) | undefined

export default definePlugin({
  name: 'ai',
  packageName: '@adonisjs-lasagna/ai',
  // Mirrors package.json#lasagnaSatellite.satelliteApi.
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  bind(app) {
    // Stateful, Map-backed: resolved via container.make, never new-ed ad hoc.
    app.container.singleton(AIProviderRegistry, () => new AIProviderRegistry())
    // The embedding-provider override registry (WS-AI-8, 2A): a host registers its
    // own embedding provider (offline mock / local dev) and it supersedes the
    // configured default. Resolved at make-time by the ingestion/retrieval
    // singletons, so a late (boot-time) host registration always wins.
    app.container.singleton(EmbeddingProviderRegistry, () => new EmbeddingProviderRegistry())
    // Live stream abort handles per tenant (G11). Stateful and cross-request,
    // so it is a container singleton like the registry.
    app.container.singleton(TenantLivenessWatcher, () => new TenantLivenessWatcher())
    // Idempotent replay over the kernel's per-tenant cache namespace. The
    // /services value import stays in THIS file (the eager-redis rule); the
    // gateway module only sees the narrow injected store seam.
    app.container.singleton(AiIdempotencyService, () => {
      const store: AiIdempotencyStore = {
        async get(tenantId, key) {
          return await cacheFor(tenantId).get<string>({ key })
        },
        async set(tenantId, key, value, ttlMs) {
          await cacheFor(tenantId).set({ key, value, ttl: ttlMs })
        },
      }
      const ai = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const resilience = new ResilienceService()
      return new AiIdempotencyService({
        store,
        macKey: deriveAiIdempotencyMacKey(requireAppKey()),
        ttlMs: ai?.idempotencyTtlMs,
        runResilient: (opts) => resilience.run(opts),
        resiliencePolicy: ai?.resilience?.idempotency?.policy,
      })
    })
    // The per-key request rate limiter (threat #4). Its redis-backed consumer is
    // built HERE (the one sanctioned toucher of the eager core barrel); the
    // gateway sees only the injected AiRateLimiter. Redis is resolved through the
    // app container's `'redis'` binding (the same RedisManager singleton
    // `@adonisjs/redis/services/main` returns), so the satellite adds no direct
    // redis dependency and shares the host's single connection manager.
    app.container.singleton(AiRateLimiter, () => {
      const ai = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const getRedis = () => app.container.make('redis')
      const resilience = new ResilienceService()
      return new AiRateLimiter({
        consume: (args) => consumeRateLimit({ getRedis, ...args }),
        policy: ai?.rateLimit,
        runResilient: (opts) => resilience.run(opts),
        resiliencePolicy: ai?.resilience?.rateLimit?.policy,
      })
    })
    // Conversation memory (WS-AI-4, I2). Encrypted at rest through the kernel's
    // fail-closed, domain-separated secret seam (writeSecret/readSecret bound to
    // the 'aiConversationMemory' class), stored as an atomic Redis LIST via the
    // same `'redis'` binding the rate limiter uses. The enc_v2 write/read pass in
    // as narrow injected deps so the gateway module never value-imports core; the
    // OLD_APP_KEY grace read (dual-key rotation) is wired only when that env is
    // set. Metrics + a metadata-only warn make a persist/decrypt failure observable.
    app.container.singleton(ConversationMemoryService, async (resolver) => {
      const ai = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const metrics = await resolver.make(MetricsService)
      const logger = await resolver.make('logger')
      const resilience = new ResilienceService()
      // Wave 5: the encrypt/decrypt seams are chosen by config.ai.memory.encryption. The
      // session MAC key stays APP_KEY-derived in BOTH modes (it binds a session token to
      // the principal; it is not the at-rest blob key).
      const encryptionSeams = await buildMemoryEncryptionSeams(app, ai, metrics)
      return new ConversationMemoryService({
        getRedis: () => app.container.make('redis'),
        runResilient: (opts) => resilience.run(opts),
        resiliencePolicy: ai?.resilience?.memory?.policy,
        macKey: deriveMemoryMacKey(requireAppKey()),
        ...encryptionSeams,
        config: ai?.memory,
        metric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        warn: (message) => logger.warn(message),
      })
    })
    // The streaming integrator resolves its quota + breaker seams from the
    // container, never new-ing them (the platform rule).
    app.container.singleton(StreamExtensionService, async (resolver) => {
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
    app.container.singleton(VectorStoreService, async () => {
      const ai = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const encryptContent = ai?.embedding?.encryptContent === true
      const encryptMetadata = ai?.embedding?.encryptMetadata === true
      // Wave 5: wire the content-at-rest seal/open seams ONLY when the host opted in and
      // the crypto peer is present (boot already asserted it). The store stays
      // crypto-primitive-free; with the flags off it binds/reads plaintext exactly as before.
      let sealContent: VectorStoreDeps['sealContent']
      let openContent: VectorStoreDeps['openContent']
      let emitMetric: VectorStoreDeps['emitMetric']
      if (encryptContent || encryptMetadata) {
        const cipher = await resolveAiFieldCipher(app)
        if (!cipher) {
          failAiConfig(
            '[ai] config.ai.embedding.encryptContent/encryptMetadata require the crypto satellite, which is not installed'
          )
        }
        const metrics = await app.container.make(MetricsService)
        sealContent = (tenantId, plain) =>
          cipher.seal(tenantId, tenantId, AI_EMBEDDINGS_DEK_CATEGORY, plain)
        openContent = (tenantId, ciph) =>
          cipher.open(tenantId, tenantId, AI_EMBEDDINGS_DEK_CATEGORY, ciph)
        emitMetric = (tenantId, name, value) => metrics.emitMetric(tenantId, name, value)
      }
      return new VectorStoreService({
        getDriver: () => getActiveDriver(),
        getDb: async () => (await resolveLucidDb(app)) as unknown as VectorDb,
        activeScopeTenantId: () => tenancy.currentId(),
        dimension: ai?.embedding?.dimension ?? DEFAULT_EMBEDDING_DIM,
        purgeStatementTimeoutMs: ai?.purgeStatementTimeoutMs,
        encryptContent,
        encryptMetadata,
        sealContent,
        openContent,
        emitMetric,
      })
    })
    // The ingestion orchestrator. It injects the store, the kernel quota
    // (reserve/settle/release/getLimit), the SSRF-pinned fetch, and the integer
    // metric sink; the embedding provider is built from `config.ai.embedding`.
    app.container.singleton(EmbeddingIngestionService, async (resolver) => {
      const store = await resolver.make(VectorStoreService)
      const quota = await resolver.make(QuotaService)
      const metrics = await resolver.make(MetricsService)
      const embedding = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai?.embedding
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
    app.container.singleton(RetrievalService, async (resolver) => {
      const store = await resolver.make(VectorStoreService)
      const quota = await resolver.make(QuotaService)
      const metrics = await resolver.make(MetricsService)
      const embedding = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai?.embedding
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
    const audit = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai?.audit
    if (audit?.enabled !== false) {
      app.container.singleton(AiAuditWriter, () => {
        const { connectionName, schemaName } = backofficeWiring(app)
        return new AiAuditWriter({
          getDb: async () => (await resolveLucidDb(app)) as unknown as AuditDb,
          connectionName,
          schemaName,
          activeScopeTenantId: () => tenancy.currentId(),
          // External anchoring (#6): reuse the kernel audit destination registry
          // the operator already configures, so kernel + AI audit share one
          // SIEM/WORM stream. Best-effort, after the canonical commit.
          getDestinations: () => app.container.make(AuditLogDestinationRegistry),
          runExtension: executeExtension,
        })
      })
      // The at-most-once action ledger (WS-AI-11 Phase 3a). It fences a confirmed
      // action's effect with a claim row in the shared backoffice schema, wired the
      // same way as the audit writer. Registered only when audit is on, because the
      // executor consults it only for action tools and those require audit (below).
      app.container.singleton(AiActionLedger, () => {
        const { connectionName, schemaName } = backofficeWiring(app)
        return new AiActionLedger({
          getDb: async () => (await resolveLucidDb(app)) as unknown as ActionLedgerDb,
          connectionName,
          schemaName,
          activeScopeTenantId: () => tenancy.currentId(),
        })
      })
      app.container.singleton(
        PgChatAuditSink,
        async (resolver) => new PgChatAuditSink(await resolver.make(AiAuditWriter))
      )
      app.container.singleton(
        PgEmbeddingAuditSink,
        async (resolver) => new PgEmbeddingAuditSink(await resolver.make(AiAuditWriter))
      )
      app.container.singleton(
        PgRetrievalAuditSink,
        async (resolver) => new PgRetrievalAuditSink(await resolver.make(AiAuditWriter))
      )
      // The tool-execution audit sink (WS-AI-11). Registered here so it resolves
      // when the tool loop is wired live (Phase 9); it maps `op: 'tool'` rows onto
      // the same fail-closed, hash-chained writer as chat / embed / retrieval.
      app.container.singleton(
        PgToolAuditSink,
        async (resolver) => new PgToolAuditSink(await resolver.make(AiAuditWriter))
      )
      // The read/query + export side of the audit trail (Wave 4, 3.1/3.2). SELECT-only
      // over the chain table, plus the additive checkpoint table; the SAME injected
      // tenancy deps as the writer, so it inherits the qualified-table + re-assert
      // discipline. Consumed by the admin-gated ai_audit_controller and the export/
      // archive commands. Registered only when audit is on (there is nothing to read otherwise).
      app.container.singleton(AiAuditReader, () => {
        const { connectionName, schemaName } = backofficeWiring(app)
        return new AiAuditReader({
          getDb: async () => (await resolveLucidDb(app)) as unknown as AuditDb,
          connectionName,
          schemaName,
          activeScopeTenantId: () => tenancy.currentId(),
        })
      })
      // The anomaly watcher (Wave 4, 3.6): sliding-window guard-trip velocity. A
      // container singleton (stateful, cross-request), subscribed to the
      // IsthmusGuardTripped bus in ready(). Fail-open: onAnomaly if the host wired one,
      // else fan the summary to the host audit destinations (the SIEM anchor path).
      app.container.singleton(AiAuditAnomalyWatcher, async (resolver) => {
        const ai = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
        const metrics = await resolver.make(MetricsService)
        const anomalyCfg = ai?.audit?.anomaly
        const onAnomaly = ai?.audit?.onAnomaly
        return new AiAuditAnomalyWatcher({
          ...(anomalyCfg?.windowMs !== undefined ? { windowMs: anomalyCfg.windowMs } : {}),
          ...(anomalyCfg?.threshold !== undefined ? { threshold: anomalyCfg.threshold } : {}),
          emitMetric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
          ...(onAnomaly ? { onAnomaly } : { fanOut: (summary) => anchorAnomaly(app, summary) }),
        })
      })
    }
    // The tool executor (WS-AI-11). Stateful only through its injected seams — the
    // SAME tenancy pair the vector store / audit writer take (`tenancy.run` /
    // `tenancy.currentId`) — so it is a container singleton resolved via
    // container.make, never new-ed ad hoc. It reads config.ai.tools at execution
    // time (per-request bounds), meters the per-outcome / latency integer metrics,
    // and writes one best-effort op:'tool' audit row per call when audit is on
    // (a disabled-audit host never registers PgToolAuditSink, so pass none). The
    // chat controller resolves it lazily — only when config.ai.tools is present —
    // and drives it through `forRequest`.
    app.container.singleton(ToolExecutorService, async (resolver) => {
      const metrics = await resolver.make(MetricsService)
      const auditOn =
        app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai?.audit?.enabled !== false
      // Action-tool confirmation machinery (Phase 3a) is wired ONLY when audit is on:
      // an action's intent must be durably recorded before it runs, so with audit off
      // the fail-closed intent write would degrade to a no-op and an action must not be
      // able to run at all. With these two undefined every action refuses
      // `tool_action_unavailable` (503), and a read tool is unaffected either way.
      return new ToolExecutorService({
        runScoped: (tenant, fn) => tenancy.run(tenant, fn),
        activeScopeTenantId: () => tenancy.currentId(),
        getToolsConfig: () => app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai?.tools,
        toolAudit: auditOn ? await resolver.make(PgToolAuditSink) : undefined,
        emitMetric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        confirmationMacKey: auditOn ? deriveAiToolConfirmationMacKey(requireAppKey()) : undefined,
        actionLedger: auditOn ? await resolver.make(AiActionLedger) : undefined,
      })
    })
    // The WS-AI-9 compliance orchestrator. Composes the purge seams (memory +
    // vector + idempotency epoch) into GDPR-grade erasure, records the admin
    // action via the KERNEL audit best-effort, and runs vector work inside
    // `tenancy.run` so the raw-SQL ContextSeal actively protects. Stateful only
    // through its injected seams: a container singleton.
    app.container.singleton(AiComplianceService, async (resolver) => {
      const ai = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
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
        getRedis: () => app.container.make('redis'),
        // Best-effort kernel audit of the purge, alongside gdpr.anonymize / destroy (E20).
        auditLog: async (options) => (await app.container.make(AuditLogService)).log(options),
        // Full AI-audit-chain verify only under --verify-chain (E10), and only when audit is on.
        verifyAuditChain: auditEnabled
          ? async (tenantId) => (await app.container.make(AiAuditWriter)).verify(tenantId)
          : undefined,
        metric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        warn: (message) => logger.warn(message),
      })
    })
  },

  async boot(app) {
    const config = app.config.get<MultitenancyConfigWithAi>('multitenancy')
    assertAiConfig(config?.ai)
    await registerBuiltinProviders(app, config?.ai)

    // Keep the AI authorization posture visible: the same wording as the
    // mount-time warning, surfaced by `tenant:doctor` even before any route
    // file runs (the backup satellite's boot-time registration pattern).
    const doctor = await app.container.make(DoctorService)
    doctor.register(
      aiMembershipGateCheck(() => app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai)
    )
    // Keep the cost-metering posture visible too: an unbudgeted aiTokens quota
    // leaves the endpoint unmetered (denial of wallet). The check reports the
    // live posture; the boot warning fires only for the genuinely-unbudgeted,
    // not-acknowledged, non-dynamic case (a static read cannot see a dynamic
    // per-tenant budget, so it must not hard-fail).
    doctor.register(aiBudgetCheck(() => app.config.get<MultitenancyConfigWithAi>('multitenancy')))
    // Keep the retrieval authorization posture visible too (WS-AI-5, G2): with
    // embeddings configured but no per-user document ACL wired, retrieval is
    // fail-closed (refused) until the host wires retrievalFilter or acknowledges
    // the tenant-wide posture. The check always reports the live posture; the boot
    // warning fires only for the refused case (see aiRetrievalGatePosture).
    doctor.register(
      aiRetrievalGateCheck(() => app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai)
    )
    // Keep the audit posture visible (WS-AI-7): audit is fail-closed and on by
    // default, so an un-provisioned backoffice.ai_audit_logs table would 503 every
    // AI request at runtime. The ai_audit check probes the table (and the app
    // role) at diagnosis time; a config-only boot warning could not see the table.
    doctor.register(
      aiAuditCheck({
        getAiConfig: () => app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai,
        getDb: async () => (await resolveLucidDb(app)) as unknown as AuditDb,
        ...backofficeWiring(app),
      })
    )
    // Keep the conversation-memory posture visible (WS-AI-4, I2): memory binds a
    // session to the resolved principal, so an enabled-but-no-principal memory is
    // inert (stateless). The check reports the live posture; it is info-only, so
    // there is no boot warning.
    doctor.register(
      aiMemoryCheck(() => app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai)
    )
    // Keep the input-injection posture visible (Wave 3, LLM01): info-only, reporting
    // whether a host semantic classifier is wired (defense-in-depth, never the
    // boundary), scanRetrieved, and the onError posture. No posture is a failure —
    // the structural boundary (fence neutralization + role separation, I4) is always
    // the isolation control, so this never warns.
    doctor.register(
      aiInjectionCheck(() => app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai)
    )
    // Keep the tool-calling posture visible (WS-AI-11, I7): with tools offered but
    // no per-tool authorizeTool ACL, tool calling is fail-closed (refused) until the
    // host wires the hook or acknowledges the tenant-wide posture; the check also
    // flags an enabled-but-inert action-tool flag. The check always reports the live
    // posture; the boot warning fires only for the refused case (see aiToolsPosture).
    doctor.register(
      aiToolsCheck(() => app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai)
    )
    // Keep the WS-AI-9 purge posture visible (read-only): Redis reachability for
    // memory/cache erasure + a keyPrefix note. It never bumps the epoch.
    doctor.register(
      aiComplianceCheck({
        getAiConfig: () => app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai,
        getRedis: () => app.container.make('redis'),
      })
    )
    // Register the AI compliance posture controls (WS-AI-9) into the shared
    // ComplianceReportService, so `tenant:compliance:report` surfaces AI residency,
    // right-to-erasure, and the embeddings-survive-anonymize transparency (E24).
    if (config?.ai) {
      const compliance = await app.container.make(ComplianceReportService)
      compliance.register(aiDataResidencyControl)
      compliance.register(aiRightToErasureControl)
      if (config.ai.embedding) compliance.register(aiEmbeddingRetentionControl)
    }
    if (config?.ai) {
      // Wave 5: a host that selected tenant-dek memory or encrypted embeddings must have
      // the optional crypto peer installed, or boot fails CLOSED (never a silent fallback
      // to the fleet APP_KEY). A no-op for the default (app-key memory, plaintext embeddings).
      await assertCryptoPeerForAtRest(app, config.ai)
      // Wave 1: an unbudgeted, unacknowledged, non-dynamic aiTokens quota is now a
      // FAIL-CLOSED boot abort (it was a warning that scrolled past). The acknowledge
      // escape hatch and the info-only dynamic/operator-ceiling postures still let
      // boot proceed, because they never reach the 'warn' severity this asserts on.
      assertAiTokensBudgetOrAbort(config)
      const retrievalPosture = aiRetrievalGatePosture(config.ai)
      if (retrievalPosture?.severity === 'warn') {
        const logger = await app.container.make('logger')
        logger.warn(`[ai] ${retrievalPosture.message}`)
      }
      const toolsPosture = aiToolsPosture(config.ai)
      if (toolsPosture?.severity === 'warn') {
        const logger = await app.container.make('logger')
        logger.warn(`[ai] ${toolsPosture.message}`)
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
      const hooks = await app.container.make(HookRegistry)
      hooks.after('provision', async ({ tenant }) => {
        const driver = await getActiveDriver()
        if (driver.name !== 'database-pg') return
        // provisionVectorExtension swallows a per-database CREATE EXTENSION
        // failure into a `failed` count (the install run continues), so pass a
        // logger and inspect the summary: a provision-time failure must not be
        // silent. It stays fail-closed downstream (the embeddings migration
        // hard-fails on the missing `vector` type and the pgvector doctor check
        // flags the tenant), but the operator should see it here, not only later.
        const logger = await app.container.make('logger')
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
  },

  async ready(app) {
    // Emitter subscriptions belong in ready(), resolved via container.make:
    // the emitter service module is unassigned until the booted hooks run
    // (the kernel's documented wireResolutionCacheInvalidation regression).
    const emitter = await app.container.make('emitter')
    const watcher = await app.container.make(TenantLivenessWatcher)
    teardownLiveness = wireAiTenantLiveness(emitter, watcher)

    // Bridge tenantful guard trips to the per-tenant integer-metric rail.
    const metrics = await app.container.make(MetricsService)
    setAiGuardMetricSink((tenantId, name, value) => metrics.emitMetric(tenantId, name, value))

    // WS-AI-9 auto-purge: erase a tenant's Redis-resident AI data (cache epoch +
    // conversation memory) when core destroys or anonymizes it, reusing core's
    // own lifecycle events rather than a parallel flow. On destroy the schema is
    // already dropped (so no vector call); on anonymize embeddings are kept by
    // design (decision 1). The handlers are NON-throwing (the core command has
    // already committed) and emit `guard.ai_auto_purge_failed` + a metric on
    // failure, so a silent GDPR erasure is impossible (E6/E19/E24).
    if (app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai) {
      const compliance = await app.container.make(AiComplianceService)
      offTenantDeleted = emitter.on(TenantDeleted, async (event) => {
        await compliance.autoPurge(event.tenant, 'tenant_deleted')
      })
      offTenantAnonymized = emitter.on(TenantAnonymized, async (event) => {
        await compliance.autoPurge(event.tenant, 'tenant_anonymized')
      })
    }

    // Anomaly watcher (Wave 4, 3.6): subscribe to the already-dispatched
    // IsthmusGuardTripped bus and count guard-trip velocity. Only when audit is on
    // (a disabled-audit host has no consumption pillar). Fail-open, off the request
    // path; torn down in shutdown().
    const aiCfg = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
    if (aiCfg && aiCfg.audit?.enabled !== false) {
      const anomalyWatcher = await app.container.make(AiAuditAnomalyWatcher)
      offAnomalyWatcher = wireAiAuditAnomalyWatcher(
        emitter,
        IsthmusGuardTripped,
        anomalyWatcher,
        () => Date.now()
      )
    }
  },

  async shutdown() {
    teardownLiveness?.()
    teardownLiveness = undefined
    offTenantDeleted?.()
    offTenantDeleted = undefined
    offTenantAnonymized?.()
    offTenantAnonymized = undefined
    offAnomalyWatcher?.()
    offAnomalyWatcher = undefined
    setAiGuardMetricSink(undefined)
  },
})

/**
 * Fan an anomaly summary to the host audit destinations (Wave 4, 3.6), reusing the
 * same anchor path the audit writer uses: map onto the kernel `AuditLogEntry` (the
 * first-class `ai` actor, action `ai:anomaly`, the content-free summary in metadata),
 * time-bounded and isolated per destination. Best-effort by construction — a throw
 * here is swallowed by the watcher's fail-open delivery wrapper.
 */
async function anchorAnomaly(app: ApplicationService, summary: AIAnomalySummary): Promise<void> {
  const registry = await app.container.make(AuditLogDestinationRegistry)
  const destinations = registry.list()
  if (destinations.length === 0) return
  const entry: AuditLogEntry = {
    id: randomUUID(),
    tenantId: summary.tenantId,
    actorType: 'ai',
    actorId: summary.principalHash,
    action: 'ai:anomaly',
    metadata: {
      guard: summary.guard,
      count: summary.count,
      windowMs: summary.windowMs,
      firstAt: summary.firstAt,
      lastAt: summary.lastAt,
    },
    ipAddress: null,
    createdAt: summary.lastAt,
  }
  await Promise.allSettled(
    destinations.map((dest) =>
      executeExtension(() => Promise.resolve(dest.write(entry)), {
        label: `ai-anomaly:${dest.name}`,
        timeoutMs: AI_AUDIT_ANCHOR_TIMEOUT_MS,
      })
    )
  )
}

/**
 * Register the built-in providers that are allow-listed and configured. An
 * unconfigured provider is simply not registered, so it can never be silently
 * selected; a host registers custom / BYOK providers in its own provider.
 */
async function registerBuiltinProviders(
  app: ApplicationService,
  ai: AiConfig | undefined
): Promise<void> {
  if (!ai) return
  const registry = await app.container.make(AIProviderRegistry)
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
 * config repository, which is populated for both register() and boot(), unlike
 * core's getConfig() singleton, seeded only in core's boot(), which runs after AI's
 * register().
 */
function backofficeWiring(app: ApplicationService): { connectionName: string; schemaName: string } {
  const mt = app.config.get<MultitenancyConfigWithAi>('multitenancy')
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

/** The kernel's own APP_KEY source (utils/crypto.ts requireAppKey pattern). */
function requireAppKey(): string {
  const appKey = process.env.APP_KEY
  if (!appKey) {
    throw new Error('[ai] APP_KEY is not set; the idempotency MAC key derives from it')
  }
  return appKey
}

// --- Data at rest (Wave 5, GATED) ---
// The `crypto` satellite is an OPTIONAL peer: the AI package works without it (memory is
// app-key sealed, embeddings are plaintext). So it is NEVER value-imported at module load
// (a static import would make the AI provider fail to load whenever crypto is absent);
// the at-rest paths resolve it lazily, and boot fails CLOSED if a host selected an at-rest
// DEK without installing it. Mirrors the admin -> sso optional-peer pattern.

/** Type-only handle on the optional crypto peer's public surface (erased at build). */
type CryptoModule = typeof import('@adonisjs-lasagna/crypto')

/** The narrow seal/open the at-rest paths need, over crypto's fail-closed field-encryption facade. */
interface AiFieldCipher {
  seal: (tenantId: string, subject: string, category: string, plaintext: string) => Promise<string>
  open: (tenantId: string, subject: string, category: string, ciphertext: string) => Promise<string>
}

/** Load the optional crypto peer, or null when it is not installed. */
async function loadCryptoModule(): Promise<CryptoModule | null> {
  try {
    return await import('@adonisjs-lasagna/crypto')
  } catch {
    return null
  }
}

/**
 * Resolve crypto's field-encryption core into the narrow {@link AiFieldCipher}, or null
 * when crypto is not installed. The `{ id: tenantId }` tenant reference is all the
 * wrapped-DEK store reads (it dereferences only `tenant.id`); the memory hot path holds
 * no full tenant object and runs with no ambient tenancy scope, which is safe because the
 * store's ContextSeal only fires when a scope IS bound (here it is not, so the
 * caller-supplied tenant id is trusted).
 */
async function resolveAiFieldCipher(app: ApplicationService): Promise<AiFieldCipher | null> {
  const mod = await loadCryptoModule()
  if (!mod) return null
  const crypto = await app.container.make(mod.CryptoService)
  const tenantRef = (tenantId: string) => ({ id: tenantId }) as unknown as TenantModelContract
  return {
    seal: (tenantId, subject, category, plaintext) =>
      crypto.encryptField(tenantRef(tenantId), subject, category, plaintext),
    open: (tenantId, subject, category, ciphertext) =>
      crypto.decryptField(tenantRef(tenantId), subject, category, ciphertext),
  }
}

/**
 * Boot gate (Wave 5): a host that selects `tenant-dek` memory or encrypted embeddings
 * MUST have the crypto peer installed, or boot fails CLOSED through the same
 * `guard.ai_config_invalid` choke the config validator uses. Selecting an at-rest DEK is a
 * STRENGTHENING of the default, so there is no acknowledge escape hatch; a host that asked
 * for tenant-DEK memory without crypto must never silently fall back to the fleet key.
 */
async function assertCryptoPeerForAtRest(app: ApplicationService, ai: AiConfig): Promise<void> {
  const wantsMemoryDek = ai.memory?.encryption === 'tenant-dek'
  const wantsEmbeddingCipher =
    ai.embedding?.encryptContent === true || ai.embedding?.encryptMetadata === true
  if (!wantsMemoryDek && !wantsEmbeddingCipher) return
  if ((await loadCryptoModule()) === null) {
    const which = wantsMemoryDek
      ? 'config.ai.memory.encryption = "tenant-dek"'
      : 'config.ai.embedding.encryptContent/encryptMetadata'
    failAiConfig(
      `[ai] ${which} requires the optional crypto satellite (@adonisjs-lasagna/crypto), which is not installed. ` +
        'Install and configure it, or drop the at-rest setting; the AI package must not silently fall back to the fleet APP_KEY.'
    )
  }
}

/**
 * Build the memory encrypt/decrypt/previous seams for the configured at-rest mode (Wave 5).
 * `'app-key'` (default) reproduces today byte-for-byte: `writeSecret`/`readSecret` under the
 * `aiConversationMemory` secret class, now wrapped in resolved promises and ignoring the
 * tenant id (the fleet key is not per-tenant), plus the `OLD_APP_KEY` grace read.
 * `'tenant-dek'` seals under a per-tenant memory DEK from crypto; a shredded/absent DEK
 * degrades the read to empty (fail-safe), and a KeyProvider outage is surfaced via a
 * distinct metric. No per-blob previous-key grace on that path (KEK rotation lives inside
 * the KeyProvider), so `decryptMemoryPrevious` is unused there.
 */
async function buildMemoryEncryptionSeams(
  app: ApplicationService,
  ai: AiConfig | undefined,
  metrics: MetricsService
): Promise<
  Pick<ConversationMemoryDeps, 'encryptMemory' | 'decryptMemory' | 'decryptMemoryPrevious'>
> {
  const mode = ai?.memory?.encryption ?? DEFAULT_AI_MEMORY_ENCRYPTION
  if (mode === 'tenant-dek') {
    const cipher = await resolveAiFieldCipher(app)
    if (!cipher) {
      // boot() already asserts this; defense in depth for a make() that beats boot.
      failAiConfig(
        '[ai] config.ai.memory.encryption = "tenant-dek" requires the crypto satellite, which is not installed'
      )
    }
    return {
      encryptMemory: (tenantId, plain) =>
        cipher.seal(tenantId, tenantId, AI_MEMORY_DEK_CATEGORY, plain),
      decryptMemory: async (tenantId, ciphertext) => {
        try {
          return await cipher.open(tenantId, tenantId, AI_MEMORY_DEK_CATEGORY, ciphertext)
        } catch (error) {
          // A shredded/absent DEK (`dek_missing`) is the EXPECTED crypto-erase outcome: the
          // read degrades to empty and fires NO error metric (a shred is not a fault). Any
          // other failure (a KMS / KeyProvider outage) is surfaced via the distinct
          // DEK-unavailable metric so it is not mistaken for a botched rotation, then
          // re-thrown so the turn still degrades fail-safe (today's store-outage posture).
          if ((error as { code?: string } | null)?.code !== 'dek_missing') {
            metrics.emitMetric(tenantId, AI_MEMORY_DEK_UNAVAILABLE_METRIC, 1)
          }
          throw error
        }
      },
      decryptMemoryPrevious: undefined,
    }
  }

  const currentAppKey = requireAppKey()
  const oldAppKey = process.env.OLD_APP_KEY
  return {
    encryptMemory: (_tenantId, plain) =>
      Promise.resolve(writeSecret(plain, 'aiConversationMemory')),
    decryptMemory: (_tenantId, cipher) =>
      Promise.resolve(readSecret(cipher, 'aiConversationMemory')),
    decryptMemoryPrevious:
      oldAppKey && oldAppKey !== currentAppKey
        ? (_tenantId, cipher) =>
            Promise.resolve(decryptWithAppKey(cipher, oldAppKey, SECRET_CLASS.aiConversationMemory))
        : undefined,
  }
}

/** Construct a built-in provider from its config block; custom names are host-registered. */
function buildBuiltinProvider(name: string, ai: AiConfig): AIProviderContract | undefined {
  if (name === 'claude' && ai.claude) return new ClaudeProvider(ai.claude)
  if (name === 'deepseek' && ai.deepseek) return new DeepSeekProvider(ai.deepseek)
  if (name === 'kimi' && ai.kimi) return new KimiProvider(ai.kimi)
  return undefined
}
