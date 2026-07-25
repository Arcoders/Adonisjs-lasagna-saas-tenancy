import { createHash } from 'node:crypto'

/**
 * The gateway's audit seam: the ONE attribution point every choke point routes
 * through. The real append-only audit is live: the `Pg*AuditSink`
 * implementations in `audit_sinks.ts` map each frozen event onto the hash-chained,
 * DB-trigger-immutable, fail-closed `AiAuditWriter`. The no-op defaults below remain
 * only as the audit-DISABLED fallback (a host that set `config.ai.audit.enabled =
 * false`), never the shipped default when audit is on.
 *
 * The field set is pinned by a spec (exact key set): adding a field is a
 * reviewed decision, and neither prompt nor response content can ever slip in
 * silently. `principalHash` is a one-way SHA-256 of the principal, so the
 * event attributes without storing an identifier that GDPR erasure would have
 * to chase into the immutable store.
 */
export interface AiGatewayAuditEvent {
  readonly tenantId: string
  readonly principalHash: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly outcome: 'completed' | 'aborted' | 'failed_preflight'
  readonly reason: string | null
  readonly tokensSettled: number
  readonly fragments: number
  readonly idempotentReplay: boolean
  readonly occurredAt: string
}

export interface AiGatewayAuditSink {
  append(event: AiGatewayAuditEvent): Promise<void> | void
}

/** The audit-disabled fallback sink: used only when `config.ai.audit.enabled` is false. */
export const noopAuditSink: AiGatewayAuditSink = {
  append: () => {},
}

/**
 * The embed choke point's attribution event. A PARALLEL event, not an
 * extension of {@link AiGatewayAuditEvent}, whose field set is frozen by its own
 * spec: an embed has no stream fragments, and it carries a `dimension` and an
 * `embeddingsCount` the chat event does not. Every field is non-PII:
 * `actorHash` and `sourceHash` are one-way SHA-256, never the raw principal or
 * document key, and neither the embedded text nor a vector ever appears.
 */
export interface AiEmbeddingAuditEvent {
  readonly tenantId: string
  readonly actorHash: string | null
  readonly model: string | null
  readonly dimension: number
  readonly embeddingsCount: number
  readonly tokens: number
  readonly sourceHash: string | null
  readonly outcome: 'completed' | 'failed_preflight'
  readonly reason: string | null
  readonly occurredAt: string
}

export interface AiEmbeddingAuditSink {
  append(event: AiEmbeddingAuditEvent): Promise<void> | void
}

/** The audit-disabled fallback embed sink (live: PgEmbeddingAuditSink). */
export const noopEmbeddingAuditSink: AiEmbeddingAuditSink = {
  append: () => {},
}

/**
 * The retrieval choke point's attribution event. A PARALLEL event, not
 * an extension of the chat/embed ones, frozen by its own spec: a retrieval has no
 * stream fragments and no stored rows, but it carries a `matchCount` the others
 * do not. Every field is non-PII: `actorHash` is a one-way SHA-256, and
 * neither the query text, a returned document, nor a vector ever appears.
 */
export interface AiRetrievalAuditEvent {
  readonly tenantId: string
  readonly actorHash: string | null
  readonly model: string | null
  /** How many matches the search returned (never the matches themselves). */
  readonly matchCount: number
  /** Provider-reported tokens settled for the query embed. */
  readonly tokens: number
  readonly outcome: 'completed' | 'failed_preflight'
  readonly reason: string | null
  readonly occurredAt: string
}

export interface AiRetrievalAuditSink {
  append(event: AiRetrievalAuditEvent): Promise<void> | void
}

/** The audit-disabled fallback retrieval sink (live: PgRetrievalAuditSink). */
export const noopRetrievalAuditSink: AiRetrievalAuditSink = {
  append: () => {},
}

/**
 * The tool-execution choke point's attribution event. A PARALLEL event,
 * not an extension of the chat/embed/retrieval ones, frozen by its own spec: a tool
 * call carries a `toolName`, a `mode`, and the loop `round` the others do not. Every
 * field is non-PII: `principalHash` is a one-way SHA-256, `toolName`/`mode`/
 * `round` are the tool identity and loop position, and NEITHER the model-generated
 * arguments NOR the tool's result ever appears (both are bounded/fenced elsewhere and
 * never audited). The `outcome` distinguishes a refusal (`denied`) from a handler
 * failure (`failed`/`error`), with the precise code in `reason`.
 */
export interface AiToolAuditEvent {
  readonly tenantId: string
  readonly principalHash: string | null
  /** The invoked tool's registered name (never its arguments). */
  readonly toolName: string
  readonly mode: 'read' | 'action'
  /**
   * `intent` is the action-tool row written BEFORE the effect, and it is
   * the only outcome that is not a result. A read tool audits best-effort after,
   * because losing the record of a read costs a log line; a mutation that ran with
   * no durable record of intent is one nobody can account for, so the write comes
   * first and fails closed. An `intent` with no later `completed` or `failed` is
   * exactly what a crashed mid-effect looks like, which is the point.
   */
  readonly outcome: 'intent' | 'completed' | 'denied' | 'failed' | 'error'
  /** The refusal / failure code (e.g. 'tool_denied', 'tool_execution_failed'), never a result value. */
  readonly reason: string | null
  /** The 1-based tool-loop round this call ran in. */
  readonly round: number
  /** LLM tokens the tool itself consumed (0 for a plain data tool; generation is metered by chat). */
  readonly tokens: number
  readonly occurredAt: string
}

export interface AiToolAuditSink {
  append(event: AiToolAuditEvent): Promise<void> | void
}

/** The audit-disabled fallback tool-audit sink (live: PgToolAuditSink). */
export const noopToolAuditSink: AiToolAuditSink = {
  append: () => {},
}

/** One-way principal attribution: SHA-256 hex, never the raw identifier. */
export function hashAuditPrincipal(principal: string | null): string | null {
  if (principal === null) return null
  return createHash('sha256').update(principal, 'utf8').digest('hex')
}
