/**
 * Single source for the demo's well-known credentials. demo:seed, the
 * afterMigrate seeding hook, the e2e helper and the auth_realms specs all
 * import from here, so the values cannot drift apart. Deliberately not read
 * from env: these are a demo affordance (demo:seed refuses to run in
 * production, and per-tenant seeding is off unless DEMO_SEED_TENANT_USERS is
 * set), so there is no secret to externalize.
 */
export const DEMO_OPERATOR = {
  email: 'operator@demo.test',
  password: 'operator-demo-password',
  fullName: 'Demo Operator',
} as const

export const DEMO_TENANT_USER = {
  email: 'user@demo.test',
  password: 'tenant-user-demo-password',
  fullName: 'Demo Tenant User',
} as const
