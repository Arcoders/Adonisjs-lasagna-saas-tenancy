import type AiAuditWriter from '../services/ai_audit_writer.js'
import type { AiAuditRow } from '../services/ai_audit_writer.js'
import type {
  AiGatewayAuditEvent,
  AiGatewayAuditSink,
  AiEmbeddingAuditEvent,
  AiEmbeddingAuditSink,
  AiRetrievalAuditEvent,
  AiRetrievalAuditSink,
} from './audit_seam.js'

/**
 * The real audit sinks (WS-AI-7). Each implements one of the FROZEN sink
 * interfaces from `audit_seam.ts` and maps its non-PII event onto a shared
 * {@link AiAuditRow} (the `op` discriminator names the choke point; fields another
 * op does not carry take a neutral default), then hands it to the one
 * {@link AiAuditWriter}. The mapping is the only place an event field becomes a
 * persisted column, so `check-ai-invariant-5` scans this file for any PII-stem
 * key. The sinks do NOT catch the writer's throw: a fail-closed audit failure must
 * surface to the controller, never be swallowed here.
 */

export class PgChatAuditSink implements AiGatewayAuditSink {
  constructor(private readonly writer: AiAuditWriter) {}

  async append(event: AiGatewayAuditEvent): Promise<void> {
    const row: AiAuditRow = {
      tenantId: event.tenantId,
      op: 'chat',
      outcome: event.outcome,
      reason: event.reason,
      principalHash: event.principalHash,
      sourceHash: null,
      provider: event.provider,
      model: event.model,
      tokens: event.tokensSettled,
      fragments: event.fragments,
      embeddingsCount: 0,
      dimension: 0,
      matchCount: 0,
      idempotentReplay: event.idempotentReplay,
      occurredAt: event.occurredAt,
    }
    await this.writer.append(row)
  }
}

export class PgEmbeddingAuditSink implements AiEmbeddingAuditSink {
  constructor(private readonly writer: AiAuditWriter) {}

  async append(event: AiEmbeddingAuditEvent): Promise<void> {
    const row: AiAuditRow = {
      tenantId: event.tenantId,
      op: 'embedding',
      outcome: event.outcome,
      reason: event.reason,
      principalHash: event.actorHash,
      sourceHash: event.sourceHash,
      provider: null,
      model: event.model,
      tokens: event.tokens,
      fragments: 0,
      embeddingsCount: event.embeddingsCount,
      dimension: event.dimension,
      matchCount: 0,
      idempotentReplay: false,
      occurredAt: event.occurredAt,
    }
    await this.writer.append(row)
  }
}

export class PgRetrievalAuditSink implements AiRetrievalAuditSink {
  constructor(private readonly writer: AiAuditWriter) {}

  async append(event: AiRetrievalAuditEvent): Promise<void> {
    const row: AiAuditRow = {
      tenantId: event.tenantId,
      op: 'retrieval',
      outcome: event.outcome,
      reason: event.reason,
      principalHash: event.actorHash,
      sourceHash: null,
      provider: null,
      model: event.model,
      tokens: event.tokens,
      fragments: 0,
      embeddingsCount: 0,
      dimension: 0,
      matchCount: event.matchCount,
      idempotentReplay: false,
      occurredAt: event.occurredAt,
    }
    await this.writer.append(row)
  }
}
