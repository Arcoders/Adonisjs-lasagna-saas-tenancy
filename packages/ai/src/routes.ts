import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'
import { assertAiMountAllowed, type MultitenancyAiRoutesOptions } from './routes/mount_gate.js'
import AiChatController from './gateway/ai_chat_controller.js'
import AiEmbedController from './gateway/ai_embed_controller.js'
import AiRetrieveController from './gateway/ai_retrieve_controller.js'
import StreamExtensionService from './gateway/stream_extension.js'
import AiIdempotencyService from './gateway/idempotency.js'
import EmbeddingIngestionService from './services/embedding_ingestion_service.js'
import RetrievalService from './services/retrieval_service.js'
import AIProviderRegistry from './services/ai_provider_registry.js'
import TenantLivenessWatcher from './services/tenant_liveness_watcher.js'
import AiRateLimiter from './services/ai_rate_limiter.js'
import ConversationMemoryService from './services/conversation_memory_service.js'
import {
  PgChatAuditSink,
  PgEmbeddingAuditSink,
  PgRetrievalAuditSink,
} from './gateway/audit_sinks.js'
import type { MultitenancyConfigWithAi } from './define_config.js'

/**
 * Mount the AI gateway routes. Call from `start/routes.ts`, AFTER the kernel
 * middleware is defined, passing your chain with TenantGuard first and your
 * auth middleware after it:
 *
 * @example
 *   // start/routes.ts
 *   import { multitenancyAiRoutes } from '@adonisjs-lasagna/ai'
 *   import { middleware } from '#start/kernel'
 *
 *   multitenancyAiRoutes({ middleware: [middleware.tenantGuard(), middleware.auth()] })
 *
 * Fail-closed (G4): refuses to mount without a middleware chain, without
 * `config.ai`, or without a membership gate (`config.ai.authorizeAIAccess`)
 * unless the host explicitly sets `acknowledgeNoMembershipGate: true`, in
 * which case the acknowledged posture is logged and kept visible by the
 * `ai_membership_gate` doctor check. The controller re-runs the gate per
 * request, so a mis-ordered chain still cannot stream unauthorized.
 *
 * Endpoints (relative to the prefix, default `/ai`):
 *   POST /chat      SSE stream (`Idempotency-Key` and `Last-Event-ID` honoured)
 *   POST /embed     ingest embeddings into the tenant vector store (JSON, WS-AI-3)
 *   POST /retrieve  similarity search over the tenant vector store (JSON, WS-AI-5)
 *
 * This module imports Adonis service singletons (router/app/logger), so it is
 * boot-unsafe BY DESIGN: import it from route files only, never from unit
 * specs (the pure mount logic lives in `routes/mount_gate.ts` for those).
 */
export function multitenancyAiRoutes(options: MultitenancyAiRoutesOptions): void {
  const ai = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
  const { warning } = assertAiMountAllowed(options, ai)
  if (warning) logger.warn(warning)

  const prefix = options.prefix ?? '/ai'
  const group = router.group(() => {
    router.post('/chat', async (ctx) => {
      const aiConfig = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const metrics = await app.container.make(MetricsService)
      const controller = new AiChatController({
        stream: await app.container.make(StreamExtensionService),
        registry: await app.container.make(AIProviderRegistry),
        idempotency: await app.container.make(AiIdempotencyService),
        liveness: await app.container.make(TenantLivenessWatcher),
        rateLimiter: await app.container.make(AiRateLimiter),
        // RAG is opt-in and only usable with embeddings configured; resolve the
        // retrieval service lazily so non-RAG chat is unaffected when they are off
        // (making RetrievalService unconditionally would throw config_missing).
        retrieval: aiConfig?.embedding ? await app.container.make(RetrievalService) : undefined,
        // The DB-backed audit sinks (WS-AI-7), on unless the host opted out; the
        // retrieval-audit sink follows the same lazy-embedding rule as `retrieval`.
        audit:
          aiConfig?.audit?.enabled !== false
            ? await app.container.make(PgChatAuditSink)
            : undefined,
        retrievalAudit:
          aiConfig?.embedding && aiConfig?.audit?.enabled !== false
            ? await app.container.make(PgRetrievalAuditSink)
            : undefined,
        // Conversation memory (WS-AI-4), resolved lazily like retrieval: only a
        // host that configured config.ai.memory pays for it (the service itself
        // no-ops via `.enabled` if a stale reference is ever passed).
        memory: aiConfig?.memory ? await app.container.make(ConversationMemoryService) : undefined,
        // Per-tenant metrics sink for `ai_output_redacted` (the optional redactOutput hook).
        emitMetric: (tenantId, name, value) => metrics.emitMetric(tenantId, name, value),
        config: aiConfig,
      })
      return controller.chat(ctx)
    })
    router.post('/embed', async (ctx) => {
      const aiConfig = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const controller = new AiEmbedController({
        ingestion: await app.container.make(EmbeddingIngestionService),
        liveness: await app.container.make(TenantLivenessWatcher),
        rateLimiter: await app.container.make(AiRateLimiter),
        audit:
          aiConfig?.audit?.enabled !== false
            ? await app.container.make(PgEmbeddingAuditSink)
            : undefined,
        config: aiConfig,
      })
      return controller.embed(ctx)
    })
    router.post('/retrieve', async (ctx) => {
      const aiConfig = app.config.get<MultitenancyConfigWithAi>('multitenancy')?.ai
      const controller = new AiRetrieveController({
        retrieval: await app.container.make(RetrievalService),
        liveness: await app.container.make(TenantLivenessWatcher),
        rateLimiter: await app.container.make(AiRateLimiter),
        audit:
          aiConfig?.audit?.enabled !== false
            ? await app.container.make(PgRetrievalAuditSink)
            : undefined,
        config: aiConfig,
      })
      return controller.retrieve(ctx)
    })
  })
  if (prefix) group.prefix(prefix)
  ;(group as any).use(options.middleware)
}

export type {
  AiMiddlewareEntry,
  AiRouteMiddleware,
  MultitenancyAiRoutesOptions,
} from './routes/mount_gate.js'
