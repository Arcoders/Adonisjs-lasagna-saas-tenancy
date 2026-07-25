import { test } from '@japa/runner'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * The per-vector coverage matrix the ARCHITECTURE demands
 * (packages/ai/ARCHITECTURE.md, "A per-vector matrix ... ships in the test suite
 * so coverage is auditable"). Each of the 18 threat vectors (the "threat model"
 * section of ARCHITECTURE.md, the numbered table) maps to a RED/behavioral covering spec and,
 * where one applies, a chaos/resilience covering spec. Paths are repo-relative and
 * every non-null one must EXIST on disk, so renaming or deleting a covering spec
 * without updating this matrix is a hard CI failure.
 *
 * MAINTENANCE: this matrix is the single auditable source of "which
 * test covers which vector". When you ADD, RENAME, or DELETE a covering spec, you
 * MUST update the matching row here. The fs-existence assertion below turns a stale
 * path into a red gate on purpose; that is the anti-drift, and it needs the
 * discipline of editing this file alongside the spec change. A `chaosSpec` (or, for
 * a genuinely un-attackable vector, a `redSpec`) may be `null` ONLY with a `reason`
 * that states the honest limit.
 */
interface VectorCoverage {
  /** The vector number, 1..18, matching the ARCHITECTURE threat-model table. */
  vector: number
  /** Short name from the table. */
  name: string
  /** The invariant that enforces it, when one does. */
  invariant?: string
  /** Repo-relative path to the RED/behavioral covering spec, or null with a reason. */
  redSpec: string | null
  /**
   * Repo-relative path(s) to the chaos/resilience covering spec(s), or null with a
   * reason. An ARRAY when more than one fault spec covers the vector: the dedicated
   * `@integration/fault_injection` tier can attach several distinct failures (a
   * provider 429, a socket drop, a malformed SSE) to one streaming vector, so a
   * single string is no longer expressive enough. Every listed path must exist on
   * disk; an empty array is treated like `null` (a coverage gap needing a reason).
   */
  chaosSpec: string | readonly string[] | null
  /** REQUIRED whenever redSpec or chaosSpec is null (or an empty array): the honest-limit note. */
  reason?: string
}

/** Normalize a chaosSpec (single path, array, or null) to a flat list of paths. */
function chaosSpecPaths(chaosSpec: VectorCoverage['chaosSpec']): string[] {
  if (chaosSpec === null) return []
  return Array.isArray(chaosSpec) ? [...chaosSpec] : [chaosSpec as string]
}

/** True when the vector declares no chaos coverage at all (null or an empty array). */
function hasNoChaosCoverage(chaosSpec: VectorCoverage['chaosSpec']): boolean {
  return chaosSpec === null || (Array.isArray(chaosSpec) && chaosSpec.length === 0)
}

const AI = 'packages/ai/tests/@guarantees'
const ARCH = 'packages/ai/tests/@architecture'
const E2E = 'examples/api/tests/@integration/e2e/ai'
const FAULT = 'packages/ai/tests/@integration/fault_injection'

const MATRIX: VectorCoverage[] = [
  {
    vector: 1,
    name: 'Memory injection / persistent contamination',
    invariant: 'I2',
    redSpec: `${AI}/security/unit/security_memory_session_isolation.spec.ts`,
    chaosSpec: [
      `${AI}/isolation/integration/isolation_ai_cross_tenant_fuzz.spec.ts`,
      // The memory read fails open through the real kernel ResilienceService on a Redis outage.
      `${FAULT}/redis_down_request_path_reads_fail_open.spec.ts`,
    ],
  },
  {
    vector: 2,
    name: 'Prompt-size denial of service',
    redSpec: `${AI}/behavior/unit/behavior_chat_controller_preflight_statuses.spec.ts`,
    chaosSpec: `${AI}/resilience/unit/resilience_stream_extension.spec.ts`,
  },
  {
    vector: 3,
    name: 'Embedding injection / index contamination (poisoning)',
    invariant: 'I1',
    redSpec: `${AI}/security/unit/security_vector_store.spec.ts`,
    chaosSpec: `${E2E}/ai_poisoned_rag_no_cross_tenant.spec.ts`,
  },
  {
    vector: 4,
    name: 'BYOK key exploitation',
    invariant: 'I6',
    redSpec: `${AI}/security/unit/security_rate_limit_byok_per_key.spec.ts`,
    chaosSpec: `${AI}/resilience/integration/resilience_rate_limiter_outage_fail_closed.spec.ts`,
  },
  {
    vector: 5,
    name: 'Token / response replay',
    invariant: 'I3',
    redSpec: `${AI}/security/unit/security_idempotency_key_hmac_scoped.spec.ts`,
    chaosSpec: [
      `${AI}/security/integration/security_idempotency_cache_real_redis.spec.ts`,
      // The idempotency lookup fails open to no-replay through the real ResilienceService on a Redis outage.
      `${FAULT}/redis_down_request_path_reads_fail_open.spec.ts`,
    ],
  },
  {
    vector: 6,
    name: 'Audit tampering',
    invariant: 'I5',
    redSpec: `${AI}/security/unit/security_ai_audit_chain_checksum.spec.ts`,
    chaosSpec: `${AI}/security/integration/security_ai_audit_immutability_real_pg.spec.ts`,
  },
  {
    vector: 7,
    name: 'Cross-provider context poisoning',
    invariant: 'I4',
    redSpec: `${AI}/security/unit/security_residency_gate.spec.ts`,
    chaosSpec: `${AI}/resilience/unit/resilience_providers.spec.ts`,
  },
  {
    vector: 8,
    name: 'Streaming exfiltration',
    invariant: 'I4',
    redSpec: `${ARCH}/boundaries/ai_invariant_8_output_bound.spec.ts`,
    chaosSpec: `${AI}/resilience/unit/resilience_chat_client_disconnect_mid_stream.spec.ts`,
  },
  {
    vector: 9,
    name: 'Hallucination "exfiltration"',
    redSpec: `${AI}/security/unit/security_chat_rag_context_integrity.spec.ts`,
    chaosSpec: null,
    reason:
      'Quality control, not isolation. Cross-tenant leakage is 0 by construction (foreign data is never in context, I4); the residual is the model inventing content, which is not a chaos-testable isolation property.',
  },
  {
    vector: 10,
    name: 'Indirect prompt injection via RAG / tool content',
    invariant: 'I4',
    redSpec: `${AI}/security/unit/security_chat_rag_context_integrity.spec.ts`,
    chaosSpec: `${E2E}/ai_poisoned_rag_no_cross_tenant.spec.ts`,
  },
  {
    vector: 11,
    name: 'SSRF via AI-initiated fetch or BYOK endpoint',
    redSpec: `${AI}/behavior/unit/behavior_embedding_ingestion.spec.ts`,
    chaosSpec: `${AI}/behavior/unit/behavior_embedding_ingestion.spec.ts`,
  },
  {
    vector: 12,
    name: 'Tool / agent confused-deputy',
    invariant: 'I7',
    // Tool calling shipped, so this row is no longer a forward contract. The red spec is
    // the gate itself (default-deny registry, per-tool authorization, and the I7
    // re-assert of the AMBIENT scope before `tenancy.run` binds, which is the actual
    // confused-deputy check). The chaos slot is the executor's fault behaviors: a
    // handler that ignores its abort signal, one that throws, and a failing audit
    // sink each degrade without breaking the pump or the scope.
    redSpec: `${AI}/behavior/unit/behavior_tool_gate.spec.ts`,
    chaosSpec: `${AI}/behavior/unit/behavior_tool_executor.spec.ts`,
  },
  {
    vector: 13,
    name: 'Cost amplification / denial-of-wallet',
    invariant: 'I3',
    redSpec: `${AI}/behavior/unit/behavior_ai_budget_posture.spec.ts`,
    chaosSpec: `${AI}/security/integration/security_cost_governor_bites_real_redis.spec.ts`,
  },
  {
    vector: 14,
    name: 'Audit log as a sensitive-data store',
    invariant: 'I5',
    redSpec: `${AI}/security/unit/security_ai_audit_persisted_row_non_pii.spec.ts`,
    chaosSpec: `${AI}/security/integration/security_ai_purge_completeness_real_stores.spec.ts`,
  },
  {
    vector: 15,
    name: 'PII to provider / training',
    redSpec: `${AI}/security/unit/security_residency_gate.spec.ts`,
    chaosSpec: `${ARCH}/boundaries/ai_no_prompt_logging.spec.ts`,
  },
  {
    vector: 16,
    name: 'Embedding sensitivity / inversion',
    invariant: 'I1',
    redSpec: `${AI}/isolation/integration/isolation_vector_store_two_tenant_no_leak.spec.ts`,
    chaosSpec: `${AI}/security/integration/security_ai_purge_completeness_real_stores.spec.ts`,
  },
  {
    vector: 17,
    name: 'Cross-tenant existence disclosure / side channel',
    redSpec: `${AI}/security/unit/security_ai_uniform_error_no_existence_disclosure.spec.ts`,
    chaosSpec: null,
    reason:
      'A uniform 403 across a non-existent vs an unauthorized tenant is a deterministic property (asserted by the red spec, T5), not a fault to inject; timingSafeEqual guards the security-sensitive comparisons.',
  },
  {
    vector: 18,
    name: 'Vector-store resource exhaustion',
    invariant: 'I1',
    redSpec: `${AI}/security/unit/security_embedding_reserve_failclosed.spec.ts`,
    chaosSpec: `${AI}/security/unit/security_vector_store.spec.ts`,
  },
]

// The repo root, five levels up from tests/@architecture/docs/.
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

function resolveOnDisk(repoRelative: string): boolean {
  return existsSync(join(REPO_ROOT, repoRelative))
}

test.group('architectural docs: AI threat-vector coverage matrix', () => {
  test('the matrix has exactly 18 entries, one per vector 1..18', ({ assert }) => {
    assert.lengthOf(MATRIX, 18)
    const numbers = MATRIX.map((row) => row.vector).sort((a, b) => a - b)
    assert.deepEqual(
      numbers,
      Array.from({ length: 18 }, (_, i) => i + 1),
      'every vector 1..18 must be mapped exactly once'
    )
  })

  test('every mapped covering spec exists on disk', ({ assert }) => {
    const missing: string[] = []
    for (const row of MATRIX) {
      for (const path of [row.redSpec, ...chaosSpecPaths(row.chaosSpec)]) {
        if (path !== null && !resolveOnDisk(path)) {
          missing.push(`vector ${row.vector} (${row.name}) -> ${path}`)
        }
      }
    }
    assert.deepEqual(
      missing,
      [],
      `a mapped covering spec was renamed/deleted without updating the matrix:\n${missing.join('\n')}`
    )
  })

  test('a null redSpec or chaosSpec always carries an honest-limit reason', ({ assert }) => {
    const unexplained = MATRIX.filter(
      (row) => (row.redSpec === null || hasNoChaosCoverage(row.chaosSpec)) && !row.reason
    ).map((row) => `vector ${row.vector} (${row.name})`)
    assert.deepEqual(
      unexplained,
      [],
      `a null coverage slot must state why (honest limit):\n${unexplained.join('\n')}`
    )
  })
})
