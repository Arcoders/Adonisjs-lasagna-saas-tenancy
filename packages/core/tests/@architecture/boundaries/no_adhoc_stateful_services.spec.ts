import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * Anti-regression guard for two mistakes that shipped and caused real bugs:
 *
 *  1. Instance-STATEFUL services constructed ad-hoc with `new` instead of being
 *     resolved from their container singleton. `TenantQueueService` and
 *     `CircuitBreakerService` each hold a per-tenant Map; a fresh `new` gets an
 *     empty map, which silently broke `/metrics` (always empty), leaked Redis
 *     connections on polled stats endpoints, and made tenant-uninstall a no-op.
 *     They MUST be resolved via `container.make(...)`. The only legal `new` is
 *     the provider's singleton factory and the service's own module.
 *
 *  2. Importing `HttpContext` inside a job or command module. Those run with no
 *     HTTP context, so the import is a latent "resolve the wrong tenant / throw
 *     at runtime" trap. Tenant context in jobs comes from `tenancy.run()` /
 *     `TenantLogContext`, never `HttpContext`.
 *
 * The spec walks the core + satellite `src/` trees.
 */

const SRC_ROOTS = [
  fileURLToPath(new URL('../../../src/', import.meta.url)),
  fileURLToPath(new URL('../../../../sso/src/', import.meta.url)),
  fileURLToPath(new URL('../../../../billing/src/', import.meta.url)),
  fileURLToPath(new URL('../../../../admin/src/', import.meta.url)),
  fileURLToPath(new URL('../../../../backup/src/', import.meta.url)),
]

// Every instance-stateful singleton the provider registers (each holds a Map or
// an AsyncLocalStorage on the instance, so a fresh `new` silently gets empty
// state). QuotaService / ResilienceService / AuditLogService are deliberately
// NOT here: they are per-instance stateless (their state lives in Redis /
// BentoCache / module scope), so the billing satellite and the REPL legitimately
// `new` them. The provider's register() (multitenancy_provider.ts) is the single
// authority for this list. Keep them in sync when a new stateful singleton is
// registered.
const STATEFUL_SINGLETONS = [
  'TenantQueueService',
  'CircuitBreakerService',
  'BillingDriverRegistry',
  'TenantResolutionCache',
  'TenantLogContext',
  'HookRegistry',
  'ReadReplicaService',
  'IsolationDriverRegistry',
  'TenantResolverRegistry',
  'BootstrapperRegistry',
  'DoctorService',
  'ComplianceReportService',
  // Extension-surface registries: each holds a Map of host-registered
  // extensions, so a fresh `new` gets an empty set and silently drops them.
  'AuditLogDestinationRegistry',
  'EvaluationStrategyRegistry',
  'WebhookTransformerRegistry',
  'AuthorizerRegistry',
  'TenantMiddlewareRegistry',
  'CapabilityRegistry',
  // Holds the Map of plugin-registered schedules that ready() arms as native
  // @adonisjs/queue schedules; a fresh `new` gets an empty set and arms nothing.
  'TenantSchedulerService',
] as const
const NEW_STATEFUL = new RegExp(`\\bnew\\s+(${STATEFUL_SINGLETONS.join('|')})\\s*\\(`)

// Files allowed to `new` a stateful singleton: the provider (singleton factory)
// and each service's own definition module. The two `registry.ts` files are
// matched by path segment (not the bare basename) so an unrelated future
// `registry.ts` is not silently exempted. `resolver_chain` is the pure
// config→registry BUILDER (`buildResolverRegistry`): the registry it makes is
// fully seeded from the immutable config (never empty-state), and it is the sync
// resolution fallback the provider itself wires, so it is exempt on the same
// footing as the provider's factory. Paths are normalized to forward slashes
// before matching so this is cross-platform.
const NEW_ALLOWED =
  /(multitenancy_provider|billing_provider|tenant_queue_service|circuit_breaker_service|billing_driver_registry|tenant_resolution_cache|tenant_log_context|hook_registry|read_replica_service|bootstrapper_registry|doctor_service|compliance_report_service|audit_log_destination_registry|evaluation_strategy_registry|webhook_transformer_registry|authorizer_registry|tenant_middleware_registry|capability_registry|tenant_scheduler_service|isolation\/registry|resolvers\/registry|resolver_chain)\.ts$/

const HTTP_CONTEXT_IMPORT =
  /import\s+(?:type\s+)?\{[^}]*\bHttpContext\b[^}]*\}\s+from\s+['"]@adonisjs\/core\/http['"]/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

test.group('Architectural: stateful services + job context hygiene', () => {
  test('stateful singletons are never `new`-ed outside the provider / their own module', ({
    assert,
  }) => {
    const violations: string[] = []

    for (const root of SRC_ROOTS) {
      if (!existsSync(root)) continue
      for (const file of walkTsFiles(root)) {
        if (NEW_ALLOWED.test(file.replace(/\\/g, '/'))) continue
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (isComment(line)) return
          if (NEW_STATEFUL.test(line)) {
            violations.push(`${relative(root, file)}:${i + 1} — ${line.trim().slice(0, 100)}`)
          }
        })
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Stateful singleton(s) constructed with \`new\` — resolve them with ` +
        `\`container.make(...)\` instead (a fresh instance gets an empty map, ` +
        `breaking metrics / stats / destroy):\n${violations.join('\n')}`
    )
  })

  test('jobs and commands never import HttpContext', ({ assert }) => {
    const violations: string[] = []

    for (const root of SRC_ROOTS) {
      if (!existsSync(root)) continue
      for (const file of walkTsFiles(root)) {
        const normalized = file.replace(/\\/g, '/')
        const inJobOrCommand = /\/(jobs|commands)\//.test(normalized)
        if (!inJobOrCommand) continue
        const src = readFileSync(file, 'utf8')
        if (HTTP_CONTEXT_IMPORT.test(src)) {
          violations.push(relative(root, file))
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `HttpContext imported in a job/command module (no HTTP context exists there ` +
        `— use tenancy.run() / TenantLogContext):\n${violations.join('\n')}`
    )
  })

  test('detectors flag the patterns we care about (positive + negative controls)', ({ assert }) => {
    // new-stateful detector
    for (const snippet of [
      `const q = new TenantQueueService()`,
      `await new CircuitBreakerService().destroy(id)`,
      `const cache = new TenantResolutionCache()`,
      `const svc = new ReadReplicaService()`,
      `const reg = new IsolationDriverRegistry()`,
    ]) {
      assert.isTrue(NEW_STATEFUL.test(snippet), `should flag: ${snippet}`)
    }
    for (const snippet of [
      `const q = await app.container.make(TenantQueueService)`,
      `const cb = new ResilienceService()`, // stateless, allowed
      `const quota = new QuotaService()`, // stateless, billing legitimately new's it
    ]) {
      assert.isFalse(NEW_STATEFUL.test(snippet), `should NOT flag: ${snippet}`)
    }

    // HttpContext-import detector
    for (const snippet of [
      `import { HttpContext } from '@adonisjs/core/http'`,
      `import type { HttpContext } from '@adonisjs/core/http'`,
      `import { HttpContext, type HttpRequest } from '@adonisjs/core/http'`,
    ]) {
      assert.isTrue(HTTP_CONTEXT_IMPORT.test(snippet), `should flag: ${snippet}`)
    }
    for (const snippet of [
      `import type { HttpContext } from '@adonisjs/core/types/http'`, // a type re-export path, not the runtime
      `import { Job } from '@adonisjs/queue'`,
    ]) {
      assert.isFalse(HTTP_CONTEXT_IMPORT.test(snippet), `should NOT flag: ${snippet}`)
    }
  })
})
