// DEPRECATED — the admin REST API moved to its own package.
//
// `@adonisjs-lasagna/saas-tenancy/admin` was split out into
// `@adonisjs-lasagna/admin` so the admin surface (tenant CRUD, impersonation,
// satellite management) versions independently and is only installed by apps
// that mount it.
//
// This shim throws on import — the symbols are no longer here. It is kept for
// one minor so the failure is a clear instruction instead of a cryptic
// module-not-found, then removed in the next major. The core never imports the
// admin package (that would be a build cycle), so this file re-exports nothing.

throw new Error(
  "[@adonisjs-lasagna/saas-tenancy] The admin API moved to '@adonisjs-lasagna/admin'. " +
    'Run `npm i @adonisjs-lasagna/admin` and change your import: ' +
    "`import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'`."
)
