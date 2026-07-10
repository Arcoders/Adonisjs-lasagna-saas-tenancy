/**
 * Argument parsing for `create-lasagna-saas`.
 *
 * Kept pure and side-effect free so the entire input surface is unit-testable
 * without scaffolding an app or spawning a process. The executor in `run.ts` is
 * the only module that touches the filesystem.
 */

export interface StarterOptions {
  /** Directory the new app is scaffolded into, resolved against the cwd. */
  directory: string
  /** Feature bundles forwarded verbatim to `configure --with=`. */
  features: string[]
  /** Print the plan instead of executing it. */
  dryRun: boolean
}

export class InvalidOptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidOptionError'
  }
}

/**
 * A directory name we are willing to hand to `npm init adonisjs -- <dir>`.
 *
 * The leading-dash rule is not cosmetic. Arguments are passed to create-adonisjs
 * as argv without a shell, so a name like `-rf` would arrive as a flag rather
 * than as the destination. Restricting to a single path segment keeps the
 * generated app from landing outside the current directory.
 */
const DIRECTORY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Feature bundles are validated for shape, never for membership. `configure`
 * owns the bundle list, so a new core bundle needs no change here, and an
 * unknown one is rejected by `configure` with its own message.
 */
const FEATURE = /^[a-z][a-z0-9-]*$/

const WITH_PREFIX = '--with='

export function parseOptions(argv: readonly string[]): StarterOptions {
  let directory: string | undefined
  let dryRun = false
  const features: string[] = []

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }

    if (arg.startsWith(WITH_PREFIX)) {
      for (const raw of arg.slice(WITH_PREFIX.length).split(',')) {
        const feature = raw.trim()
        if (!FEATURE.test(feature)) {
          throw new InvalidOptionError(`not a valid feature bundle: ${JSON.stringify(feature)}`)
        }
        if (!features.includes(feature)) features.push(feature)
      }
      continue
    }

    if (arg.startsWith('-')) {
      throw new InvalidOptionError(`unknown flag: ${arg}`)
    }

    if (directory !== undefined) {
      throw new InvalidOptionError(`only one directory may be given, got a second: ${arg}`)
    }
    directory = arg
  }

  if (directory === undefined) {
    throw new InvalidOptionError('a target directory is required')
  }
  if (!DIRECTORY.test(directory)) {
    throw new InvalidOptionError(
      `not a valid directory name: ${JSON.stringify(directory)}. ` +
        'Use a single path segment starting with a letter or digit.'
    )
  }

  return { directory, features, dryRun }
}
