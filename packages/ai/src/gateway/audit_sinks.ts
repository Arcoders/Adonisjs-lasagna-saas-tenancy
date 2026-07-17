import type AiAuditWriter from '../services/ai_audit_writer.js'
import type { AiAuditRow } from '../services/ai_audit_writer.js'
import type {
  AiGatewayAuditEvent,
  AiGatewayAuditSink,
  AiEmbeddingAuditEvent,
  AiEmbeddingAuditSink,
  AiRetrievalAuditEvent,
  AiRetrievalAuditSink,
  AiToolAuditEvent,
  AiToolAuditSink,
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

export class PgToolAuditSink implements AiToolAuditSink {
  constructor(private readonly writer: AiAuditWriter) {}

  async append(event: AiToolAuditEvent): Promise<void> {
    // LOAD-BEARING chain-integrity reuse (WS-AI-11). `canonicalAuditFields` in
    // ai_audit_writer.ts is a POSITIONAL array: adding an element would rebreak
    // every historical row's checksum. So a tool row must NOT introduce a new
    // column — it reuses three neutral fields that no tool row otherwise needs:
    //   toolName -> model      (a tool row's "model" IS the invoked tool name)
    //   round    -> matchCount (the loop round, reusing retrieval's match counter)
    //   mode     -> provider   ('read' | 'action'; a tool row has no LLM provider)
    // These are DELIBERATE, checksum-preserving reuses, NOT literal model / provider
    // / match-count values. `op: 'tool'` is the sole discriminator: do not read
    // model / provider / matchCount on a `tool` row as an LLM model, provider, or
    // match count. Documented in ai-tools.md and pinned by
    // security_audit_seam_tool_non_pii_fields. Neither the arguments nor the result
    // is ever mapped in (they are non-PII-frozen out of the event upstream).
    const row: AiAuditRow = {
      tenantId: event.tenantId,
      op: 'tool',
      outcome: toRowOutcome(event.outcome),
      reason: event.reason,
      principalHash: event.principalHash,
      sourceHash: null,
      provider: event.mode,
      model: event.toolName,
      tokens: event.tokens,
      fragments: 0,
      embeddingsCount: 0,
      dimension: 0,
      matchCount: event.round,
      idempotentReplay: false,
      occurredAt: event.occurredAt,
    }
    await this.writer.append(row)
  }
}

/**
 * Map a tool-event outcome onto the shared row's 3-value outcome, keeping the
 * precise category in `reason` (so the row's `outcome` enum — and its column CHECK,
 * if a host adds one — never has to grow): a refusal that never ran is a
 * preflight-style refusal, a handler that ran then broke is an abort.
 */
function toRowOutcome(outcome: AiToolAuditEvent['outcome']): AiAuditRow['outcome'] {
  switch (outcome) {
    case 'completed':
      return 'completed'
    case 'denied':
      return 'failed_preflight'
    // An action's pre-effect intent maps to 'aborted' because the shared row has
    // only three values and this is not yet a success. It reads correctly on its
    // own: at the moment it is written the effect genuinely has not happened. The
    // precise state rides in `reason`, and the settled row that follows is what
    // says it landed. An intent with no follow-up is a crashed mid-effect.
    case 'intent':
    case 'failed':
    case 'error':
      return 'aborted'
  }
}
