/**
 * Single source for the demo's well-known credentials. `rental:seed`, the
 * afterMigrate seeding hook and the e2e helpers all import from here, so the
 * values cannot drift. Deliberately not read from env: `rental:seed` refuses to
 * run in production and per-tenant seeding is off unless DEMO_SEED_TENANT_USERS
 * is set, so there is no secret to externalize.
 */
export const DEMO_OPERATOR = {
  email: 'operator@karimoto.test',
  password: 'operator-demo-password',
  fullName: 'Karimoto Operator',
} as const

/** Owner staff account seeded into each demo company's schema. */
export const DEMO_TENANT_OWNER = {
  email: 'owner@karimoto.test',
  password: 'owner-demo-password',
  fullName: 'Company Owner',
} as const
