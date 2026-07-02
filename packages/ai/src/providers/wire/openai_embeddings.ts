import AIException from '../../exceptions/ai_exception.js'
import type { AIEmbeddingResult } from '../../types/ai_embedding_contract.js'

/**
 * The OpenAI `/embeddings` response wire shape. Deliberately narrow: only the
 * fields the vector store needs. `encoding_format:'float'` is forced on the
 * request, so `embedding` is a number array (never a base64 string).
 */
interface OpenAiEmbeddingsPayload {
  data?: { index?: number; embedding?: unknown }[]
  model?: string
  usage?: { total_tokens?: number }
}

/**
 * Turn a parsed OpenAI `/embeddings` JSON body into an {@link AIEmbeddingResult}.
 * Pure and defensive: it reorders vectors by their `index` (never trusting array
 * order), asserts every vector is the same length of finite numbers (the
 * dimension the store binds on), and reads `usage.total_tokens` for the reserve
 * settle. A malformed body is a provider fault surfaced as `provider_unavailable`
 * rather than a silently-wrong embedding, which would corrupt retrieval.
 */
export function parseOpenAiEmbeddings(payload: unknown, fallbackModel: string): AIEmbeddingResult {
  const body = payload as OpenAiEmbeddingsPayload
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray(body.data) ||
    body.data.length === 0
  ) {
    throw malformed('the embeddings response carried no data array')
  }

  const ordered = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const embeddings: number[][] = ordered.map((entry, i) => {
    const vector = entry.embedding
    if (!Array.isArray(vector) || vector.length === 0) {
      throw malformed(`data[${i}].embedding is not a non-empty array`)
    }
    if (!vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw malformed(`data[${i}].embedding contains a non-finite value`)
    }
    return vector as number[]
  })

  const dimension = embeddings[0].length
  if (!embeddings.every((v) => v.length === dimension)) {
    throw malformed('the embeddings response mixed vector dimensions')
  }

  const totalTokens = body.usage?.total_tokens
  const tokens = typeof totalTokens === 'number' && Number.isFinite(totalTokens) ? totalTokens : 0

  return {
    embeddings,
    model: typeof body.model === 'string' && body.model.length > 0 ? body.model : fallbackModel,
    dimension,
    tokens,
  }
}

function malformed(reason: string): AIException {
  return new AIException('provider_unavailable', `malformed embeddings response: ${reason}`)
}
