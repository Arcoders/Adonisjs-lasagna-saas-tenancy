import { createHash } from 'node:crypto'

/**
 * The gateway's audit seam. TODO(WS-AI-7): the real append-only audit lands
 * there (I5: non-PII metadata into the kernel audit rails, DB-trigger
 * immutability, the fail-closed write placement). This seam exists NOW so the
 * choke point has exactly one attribution point and WS-AI-7 inherits a frozen
 * non-PII field contract instead of a habit; the default sink is a no-op.
 *
 * The field set is pinned by a spec (exact key set): adding a field is a
 * reviewed decision, and neither prompt nor response content can ever slip in
 * silently. `principalHash` is a one-way SHA-256 of the principal, so the
 * event attributes without storing an identifier that GDPR erasure would have
 * to chase into the immutable store (G1).
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

/** The default sink until WS-AI-7: attribution is wired, storage is not. */
export const noopAuditSink: AiGatewayAuditSink = {
  append: () => {},
}

/**
 * The embed choke point's attribution event (WS-AI-3). A PARALLEL event, not an
 * extension of {@link AiGatewayAuditEvent}, whose field set is frozen by its own
 * spec: an embed has no stream fragments, and it carries a `dimension` and an
 * `embeddingsCount` the chat event does not. Every field is non-PII (I5, G1):
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

/** The default embed sink until WS-AI-7. */
export const noopEmbeddingAuditSink: AiEmbeddingAuditSink = {
  append: () => {},
}

/**
 * The retrieval choke point's attribution event (WS-AI-5). A PARALLEL event, not
 * an extension of the chat/embed ones, frozen by its own spec: a retrieval has no
 * stream fragments and no stored rows, but it carries a `matchCount` the others
 * do not. Every field is non-PII (I5, G1): `actorHash` is a one-way SHA-256, and
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

/** The default retrieval sink until WS-AI-7. */
export const noopRetrievalAuditSink: AiRetrievalAuditSink = {
  append: () => {},
}

/** One-way principal attribution: SHA-256 hex, never the raw identifier. */
export function hashAuditPrincipal(principal: string | null): string | null {
  if (principal === null) return null
  return createHash('sha256').update(principal, 'utf8').digest('hex')
}
