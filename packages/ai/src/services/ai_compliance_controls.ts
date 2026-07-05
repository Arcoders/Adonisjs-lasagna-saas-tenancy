import type { ComplianceControl } from '@adonisjs-lasagna/saas-tenancy/services'
import type { MultitenancyConfigWithAi } from '../define_config.js'

/**
 * AI compliance posture controls (WS-AI-9), surfaced by `tenant:compliance:report`
 * the same way the kernel controls are (satellites `register()` into the shared
 * `ComplianceReportService`). They are registered in `AiProvider.boot()` only
 * when `config.ai` is present, so `detect()` can assume the AI block exists.
 */

/** Read the AI block off the compliance context's config (typed via the satellite augmentation). */
function ai(config: unknown): MultitenancyConfigWithAi['ai'] {
  return (config as MultitenancyConfigWithAi).ai
}

/** Is per-tenant data residency / no-train configured (#7 / #15)? */
export const aiDataResidencyControl: ComplianceControl = {
  id: 'ai-data-residency',
  title: 'AI data residency & no-train',
  frameworks: ['gdpr:art30', 'gdpr:art44', 'soc2:CC6.7'],
  detect({ config }) {
    if (ai(config)?.residency) {
      return {
        status: 'satisfied',
        evidence:
          'config.ai.residency pins per-tenant egress; a provider or embedding backend outside ' +
          'the posture (or any remote host under local-only) is refused (residency_denied) before any cost.',
        hostResponsibility:
          'Residency is enforced by provider identity, not endpoint geography — place any BYOK baseUrl in-region yourself.',
      }
    }
    return {
      status: 'info',
      evidence:
        'config.ai.residency is not set; AI egress is constrained only by the global allowedProviders allow-list.',
      hostResponsibility:
        'Set config.ai.residency to pin per-tenant data residency / no-train (e.g. {mode:"local-only"} or an allowed-provider list).',
    }
  },
}

/** Is a right-to-erasure path available for AI data (#16, G1)? */
export const aiRightToErasureControl: ComplianceControl = {
  id: 'ai-right-to-erasure',
  title: 'AI right-to-erasure (purge)',
  frameworks: ['gdpr:art17', 'soc2:CC8.1'],
  detect() {
    return {
      status: 'satisfied',
      evidence:
        'tenant:ai:purge erases conversation memory + the response cache + embeddings per tenant / principal / ' +
        'document, and an auto-purge clears the Redis-resident data when a tenant is destroyed or anonymized.',
      hostResponsibility:
        'Wire your DSAR workflow to `tenant:ai:purge --principal <id>`, and keep resolvePrincipal STABLE: ' +
        'erasure keys to the principal id as it was at ingest (the actor hash is one-way).',
    }
  },
}

/**
 * Retention transparency (E24): embeddings survive `tenant:gdpr:anonymize` by
 * design (decision 1), so this control is INFO, never "satisfied erasure" — it
 * exists so an operator is not misled into thinking anonymize cleared the corpus.
 */
export const aiEmbeddingRetentionControl: ComplianceControl = {
  id: 'ai-embedding-retention',
  title: 'AI embedding retention after anonymize',
  frameworks: ['gdpr:art17', 'soc2:CC8.1'],
  detect() {
    return {
      status: 'info',
      evidence:
        'AI embeddings are physically tenant-isolated, but their `content` is the ingested text. ' +
        'tenant:gdpr:anonymize erases host-model PII only; it does NOT delete embeddings, so a tenant/user/document ' +
        'corpus is retained until explicitly purged.',
      hostResponsibility:
        'Include AI embeddings in your erasure runbook: run `tenant:ai:purge` (or deleteBySource for one document) ' +
        'to remove a corpus that anonymize leaves in place.',
    }
  },
}
