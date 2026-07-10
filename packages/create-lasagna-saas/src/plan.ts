/**
 * The scaffold, as data.
 *
 * `planActions` is pure: it maps options to an ordered list of things to do, and
 * `run.ts` is the only module that performs them. That split is what lets
 * `--dry-run` print the exact sequence, and what lets the unit suite pin the
 * order without a network or a database.
 *
 * The sequence is not invented. It is the one path this repository proves works
 * on a clean machine, in `scripts/clean-install-smoke.sh`, which CI runs against
 * a packed tarball rather than the workspace symlink. Change one, change both.
 */
import { databaseConfig, envBlock } from './templates.js'

export const CORE_PACKAGE = '@adonisjs-lasagna/saas-tenancy'

/**
 * The oldest core this scaffolder can produce a working app with.
 *
 * Not decoration. Before 0.3.0 the root entry never re-exported the `configure`
 * hook, so `node ace configure` printed one warning, exited 0, and published
 * nothing: no tenant model, no provider, no tenants migration. An unpinned
 * install that resolved such a version would hand the user a silently broken app
 * whose first `tenant:create` fails on a missing relation. With the floor, npm
 * refuses the install and says why.
 *
 * No upper bound: every version at or above the floor has a working hook.
 */
export const CORE_MINIMUM = '0.3.0'
export const CORE_SPEC = `${CORE_PACKAGE}@>=${CORE_MINIMUM}`

/** Peers the golden path needs. The `api` starter kit ships none of them. */
export const PEER_PACKAGES = ['pg', '@adonisjs/redis', '@adonisjs/queue'] as const

export type Action =
  | {
      kind: 'run'
      title: string
      command: string
      args: string[]
      /** `parent` is the cwd the CLI was invoked from; `app` is the new directory. */
      cwd: 'parent' | 'app'
      /** Fed to the child's stdin, for the one command that prompts. */
      stdin?: string
    }
  | { kind: 'write'; title: string; path: string; contents: string }
  | { kind: 'append'; title: string; path: string; contents: string }

export function planActions(options: { directory: string; features: readonly string[] }): Action[] {
  const { directory, features } = options

  // `--kit=api` and the destination are create-adonisjs's only two prompts, so
  // passing both makes it non-interactive. `--skip-migrations` drops the kit's
  // sqlite migrations, which this app replaces with PostgreSQL ones.
  const scaffold: Action = {
    kind: 'run',
    title: `Scaffolding a fresh AdonisJS 7 app in ${directory}/`,
    command: 'npm',
    args: [
      'init',
      'adonisjs@latest',
      '--',
      directory,
      '--kit=api',
      '--pkg=npm',
      '--skip-migrations',
    ],
    cwd: 'parent',
  }

  // --legacy-peer-deps: the api kit pins @adonisjs/session 8 while core's
  // optional peer range says 7, and npm treats that as a hard conflict.
  const install: Action = {
    kind: 'run',
    title: 'Installing Lasagna and its peers',
    command: 'npm',
    args: ['install', ...PEER_PACKAGES, CORE_SPEC, '--legacy-peer-deps'],
    cwd: 'app',
  }

  const configureRedis: Action = {
    kind: 'run',
    title: 'node ace configure @adonisjs/redis',
    command: 'node',
    args: ['ace', 'configure', '@adonisjs/redis'],
    cwd: 'app',
  }

  // The queue configure prompts for a driver; a bare newline accepts the default.
  const configureQueue: Action = {
    kind: 'run',
    title: 'node ace configure @adonisjs/queue',
    command: 'node',
    args: ['ace', 'configure', '@adonisjs/queue'],
    cwd: 'app',
    stdin: '\n',
  }

  const withFlag = features.length > 0 ? [`--with=${features.join(',')}`] : []
  const configureCore: Action = {
    kind: 'run',
    title: ['node ace configure', CORE_PACKAGE, ...withFlag].join(' '),
    command: 'node',
    args: ['ace', 'configure', CORE_PACKAGE, ...withFlag],
    cwd: 'app',
  }

  return [
    scaffold,
    install,
    configureRedis,
    configureQueue,
    configureCore,
    {
      kind: 'write',
      title: 'Writing config/database.ts (central + backoffice + tenant template)',
      path: 'config/database.ts',
      contents: databaseConfig(),
    },
    {
      kind: 'append',
      title: 'Appending the multitenancy keys to .env',
      path: '.env',
      contents: envBlock(directory),
    },
    {
      kind: 'append',
      title: 'Appending the multitenancy keys to .env.example',
      path: '.env.example',
      contents: envBlock(directory),
    },
  ]
}

/**
 * What the scaffolder cannot do for you: it does not own your PostgreSQL, and it
 * will not create a database or run migrations against one behind your back.
 */
export function nextSteps(options: { directory: string; databaseName: string }): string[] {
  return [
    `cd ${options.directory}`,
    `createdb ${options.databaseName}   # or point DB_* in .env at an existing database`,
    'node ace backoffice:setup          # creates the backoffice schema and runs its migrations',
    'node ace tenant:create "Acme Corp" "admin@acme.example.com"',
    'node ace queue:work                # drains the InstallTenant job; the tenant goes active',
  ]
}
