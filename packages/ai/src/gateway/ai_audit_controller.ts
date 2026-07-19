import type { HttpContext } from '@adonisjs/core/http'
import type AiAuditReader from '../services/ai_audit_reader.js'
import type { AiAuditQueryFilter } from '../services/ai_audit_reader.js'
import type { AiConfig } from '../define_config.js'
import type { AiAuditRow } from '../services/ai_audit_writer.js'
import { resolveRequestTenant, authorizeAuditRead } from './access_gate.js'

/**
 * The HTTP read/query surface for the AI audit trail (Wave 4, 3.1). Kept in the AI
 * satellite (admin must not hard-depend on AI), admin-gated DEFAULT-DENY through
 * `config.ai.audit.authorizeAudit`, and TENANT-SCOPED: it reads only the request
 * tenant's chain, so the reader's ContextSeal re-assert passes and one tenant can
 * never read another's rows over HTTP. Cross-tenant / all-tenants reads stay CLI-only
 * (the export/archive commands, which run with no bound scope). SELECT-only underneath.
 *
 * Instantiated per request with its deps injected by the route closure, so it never
 * value-imports the eager core barrels.
 */
export interface AiAuditControllerDeps {
  reader: AiAuditReader
  config: AiConfig | undefined
}

const OPS: ReadonlySet<string> = new Set(['chat', 'embedding', 'retrieval', 'tool'])
const OUTCOMES: ReadonlySet<string> = new Set(['completed', 'aborted', 'failed_preflight'])

export default class AiAuditController {
  constructor(private readonly deps: AiAuditControllerDeps) {}

  async list(ctx: HttpContext): Promise<void> {
    // 1. Tenant + audit-read gate (403s, default-deny), before any query.
    const tenant = await resolveRequestTenant(ctx)
    await authorizeAuditRead(ctx, tenant, this.deps.config)

    // 2. Build the filter, scoped to THIS tenant. The reader clamps page/limit and
    //    binds every value, so a hostile principalHash / op is a bound value or dropped.
    const op = ctx.request.input('op')
    const outcome = ctx.request.input('outcome')
    const from = ctx.request.input('from')
    const to = ctx.request.input('to')
    const principalHash = ctx.request.input('principalHash')

    const filter: AiAuditQueryFilter = {
      tenantId: tenant.id,
      ...(typeof op === 'string' && OPS.has(op) ? { op: op as AiAuditRow['op'] } : {}),
      ...(typeof outcome === 'string' && OUTCOMES.has(outcome)
        ? { outcome: outcome as AiAuditRow['outcome'] }
        : {}),
      ...(typeof principalHash === 'string' && principalHash.length > 0 ? { principalHash } : {}),
      ...(typeof from === 'string' && from.length > 0 ? { from } : {}),
      ...(typeof to === 'string' && to.length > 0 ? { to } : {}),
      ...(ctx.request.input('page') !== undefined
        ? { page: Number(ctx.request.input('page')) }
        : {}),
      ...(ctx.request.input('limit') !== undefined
        ? { limit: Number(ctx.request.input('limit')) }
        : {}),
    }

    const result = await this.deps.reader.query(filter)
    ctx.response.ok({ rows: result.rows, page: result.page, limit: result.limit })
  }
}
