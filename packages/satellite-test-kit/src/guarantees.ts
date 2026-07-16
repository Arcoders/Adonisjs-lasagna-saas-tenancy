// Single source of truth for the guarantee taxonomy and the test-suite globs the
// `@`-prefixed directory convention derives from. Pure: imports nothing from
// `@adonisjs/*`, lucid, the app, or `@japa/*`, so it is safe to import before the
// app boots AND from the no-build unit loop via a relative source path (the unit
// runners must not pull in anything that needs a build).
//
// The broad globs use `**` and so never enumerate the individual guarantees:
// adding a guarantee is a new directory, discovered automatically. The taxonomy
// below exists for VALIDATION (the anti-drift architectural test, the
// `test:guarantee` argument, the `guaranteeFilter`), not for building the globs.

export const GUARANTEES = [
  'isolation',
  'security',
  'behavior',
  'resilience',
  'performance',
] as const

export type Guarantee = (typeof GUARANTEES)[number]

/**
 * The harness leaves that live inside every guarantee. `unit` runs against
 * source with tsx and no database; `integration` boots the shared Ignitor and
 * PostgreSQL. Nothing else is a valid child of a guarantee directory.
 */
export const HARNESS_LEAVES = ['unit', 'integration'] as const

/** The sub-tiers under `tests/@architecture/` (static, unit-harness guards). */
export const ARCHITECTURE_TIERS = ['boundaries', 'contracts', 'docs'] as const

/**
 * The sub-tiers under `tests/@integration/`. `drivers` is gated on every
 * integration run; `fault_injection` is the slow chaos tier with its own
 * runner. `e2e` is the demo-app full-scenario tier (only `examples/api`).
 */
export const INTEGRATION_TIERS = ['drivers', 'fault_injection', 'e2e'] as const

/**
 * The directories allowed at the top of a package's `tests/`. The `@`-prefixed
 * ones are the guarantee tree; `helpers` and `fixtures` hold shared, non-spec
 * support. This is the allow-list the anti-drift guard pins the layout against,
 * so a stray legacy `unit/` or `e2e/` at the top level can never reappear.
 */
export const TOP_LEVEL_DIRS = [
  '@guarantees',
  '@architecture',
  '@integration',
  'helpers',
  'fixtures',
] as const

/** Narrowing guard: is `value` one of the canonical guarantees? */
export function isGuarantee(value: string): value is Guarantee {
  return (GUARANTEES as readonly string[]).includes(value)
}

/** The Japa tag for a guarantee (e.g. `isolation` -> `@isolation`). */
export function guaranteeTag(guarantee: Guarantee): string {
  return `@${guarantee}`
}

export interface GuaranteeGlobsOptions {
  /** Include the unit-harness architectural specs (`tests/@architecture/**`). Core and websockets only. */
  withArchitecture?: boolean
  /** `@integration/<dir>` directories that belong to the GATING integration run. Default `['drivers']`. */
  integrationDirs?: string[]
  /** `@integration/<dir>` directory holding the slow chaos tier, run by its own runner. Default `'fault_injection'`. */
  faultDir?: string
}

export interface GuaranteeGlobs {
  /** Unit harness: every guarantee's `unit/` leaf, plus architecture when asked. */
  unit: string[]
  /** Stack harness (gating): every guarantee's `integration/` leaf, plus the gating `@integration/<dir>`s. */
  integration: string[]
  /** Stack harness (chaos, non-gating): only the `@integration/<faultDir>` tier. */
  fault: string[]
  /** Per-guarantee globs, split by harness, for `test:guarantee <category>`. */
  guarantee(category: string): { unit: string[]; integration: string[] }
}

/**
 * Build the suite globs for the guarantee-oriented test tree. The harness
 * (unit vs integration) is the leaf inside each guarantee, so each runner can
 * select only its own specs with a recursive `**` glob.
 */
export function guaranteeGlobs(options: GuaranteeGlobsOptions = {}): GuaranteeGlobs {
  const integrationDirs = options.integrationDirs ?? ['drivers']
  const faultDir = options.faultDir ?? 'fault_injection'
  return {
    unit: [
      'tests/@guarantees/**/unit/**/*.spec.ts',
      ...(options.withArchitecture ? ['tests/@architecture/**/*.spec.ts'] : []),
    ],
    integration: [
      'tests/@guarantees/**/integration/**/*.spec.ts',
      ...integrationDirs.map((dir) => `tests/@integration/${dir}/**/*.spec.ts`),
    ],
    fault: [`tests/@integration/${faultDir}/**/*.spec.ts`],
    guarantee(category: string) {
      return {
        unit: [`tests/@guarantees/${category}/unit/**/*.spec.ts`],
        integration: [`tests/@guarantees/${category}/integration/**/*.spec.ts`],
      }
    },
  }
}

/**
 * Resolve the effective integration suite globs. With no `guaranteeFilter` this
 * is the identity over `suiteGlobs`; with one, it narrows to those guarantees'
 * `integration/` leaves and rejects an unknown guarantee loudly (a typo would
 * otherwise silently run nothing).
 */
export function resolveSuiteGlobs(input: {
  suiteGlobs: string[]
  guaranteeFilter?: string[] | undefined
}): string[] {
  const filter = input.guaranteeFilter
  if (!filter || filter.length === 0) return input.suiteGlobs
  const invalid = filter.filter((category) => !isGuarantee(category))
  if (invalid.length > 0) {
    throw new Error(
      `guaranteeFilter: unknown guarantee(s) ${invalid.join(', ')}. Valid: ${GUARANTEES.join(', ')}.`
    )
  }
  const globs = guaranteeGlobs()
  return filter.flatMap((category) => globs.guarantee(category).integration)
}
