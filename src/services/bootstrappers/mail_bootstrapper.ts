import type {
  BootstrapperContext,
  TenantBootstrapper,
} from '../bootstrapper_registry.js'
import { tenancy } from '../../tenancy.js'
import { assertSafeIdentifier } from '../isolation/identifier.js'

/**
 * Lazily resolve `@adonisjs/mail` so apps that don't install it skip the
 * bootstrapper entirely.
 */
async function lazyMail(): Promise<{ use(name?: string): any; send: any; sendLater: any }> {
  // Dynamic specifier so TypeScript doesn't pin the module path at compile
  // time — `@adonisjs/mail` is an optional peer dependency.
  const specifier = '@adonisjs/mail/services/main'
  const mod: any = await (Function('s', 'return import(s)') as (s: string) => Promise<any>)(
    specifier
  )
  return mod.default ?? mod
}

export const TENANT_MAIL_HEADER = 'X-Tenant-Id'

/**
 * Build a `TenantBootstrapper` that validates the tenant id at scope entry
 * (it lands in outbound message headers) and gives apps a `tenantMailer()`
 * helper that auto-stamps `X-Tenant-Id` on every send.
 *
 * Per-tenant transport selection (e.g., a different SMTP host per tenant)
 * is intentionally a host-app concern — the bootstrapper provides
 * `tenantMailer(transport)` so the host can pick the transport based on
 * the active tenant via its own logic.
 */
export function createMailBootstrapper(): TenantBootstrapper {
  return {
    name: 'mail',
    enter(ctx: BootstrapperContext) {
      assertSafeIdentifier(ctx.tenant.id, 'tenant id')
    },
  }
}

const mailBootstrapper = createMailBootstrapper()
export default mailBootstrapper

/**
 * Returns a Mailer-like handle for the active tenant scope. Every message
 * sent through it gets an `X-Tenant-Id` header injected automatically,
 * even if the message-compose callback didn't set one.
 *
 * Throws outside a `tenancy.run()` scope.
 *
 * @param transportName Optional transport key. If your app picks transports
 *   per tenant (e.g. each tenant has its own SMTP), pass the name here —
 *   the bootstrapper does not infer it; that's your domain logic.
 */
export async function tenantMailer(transportName?: string): Promise<any> {
  const id = tenancy.currentId()
  if (!id) {
    throw new Error(
      'tenantMailer() called outside a tenancy.run() scope. Wrap your code in tenancy.run(tenant, fn).'
    )
  }
  assertSafeIdentifier(id, 'tenant id')

  const mail = await lazyMail()
  const inner = transportName ? mail.use(transportName) : mail.use()

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'send' || prop === 'sendLater') {
        return function (callbackOrMail: unknown, config?: unknown) {
          const wrapped = wrapWithTenantHeader(callbackOrMail, id)
          return (target as any)[prop](wrapped, config)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * Wrap a `MessageComposeCallback` (or a `BaseMail` instance) so the message
 * always carries `X-Tenant-Id`. We don't mutate the original callback —
 * tests might pass a frozen/shared one — and we don't override an
 * already-set header (the host app may have a more specific value).
 */
function wrapWithTenantHeader(callbackOrMail: any, tenantId: string): any {
  if (typeof callbackOrMail === 'function') {
    return (message: any) => {
      const result = callbackOrMail(message)
      stampHeader(message, tenantId)
      return result
    }
  }
  // BaseMail instance: hook its `prepare` step.
  if (callbackOrMail && typeof callbackOrMail.prepare === 'function') {
    const originalPrepare = callbackOrMail.prepare.bind(callbackOrMail)
    callbackOrMail.prepare = (message: any) => {
      const r = originalPrepare(message)
      stampHeader(message, tenantId)
      return r
    }
  }
  return callbackOrMail
}

function stampHeader(message: any, tenantId: string): void {
  if (!message || typeof message.header !== 'function') return
  // Don't overwrite a host-set value.
  const existing = typeof message.headers === 'object' ? message.headers : null
  if (existing && existing[TENANT_MAIL_HEADER] != null) return
  message.header(TENANT_MAIL_HEADER, tenantId)
}
