/**
 * How to invoke npm without handing anything to a command interpreter.
 *
 * On Windows `npm` is `npm.cmd`, and since the fix for CVE-2024-27980 (Node
 * 18.20.2, 20.12.2, 21.7.3 and everything after, so every Node this package
 * supports) `spawn` refuses to execute a `.cmd` or `.bat` without `shell: true`.
 * It fails with EINVAL before the command runs.
 *
 * `shell: true` would fix the spawn and break the arguments. cmd.exe parses the
 * joined command line, so the version floor `@adonisjs-lasagna/saas-tenancy@>=0.3.0`
 * would be read as a redirection into a file named `=0.3.0`. Node does not quote
 * arguments for you when `shell` is set.
 *
 * So neither. npm is a Node program: run it with the Node that is already
 * running this one, and the argument vector is passed through untouched. There
 * is no shell anywhere in this package.
 *
 * Kept pure and injectable so the win32 branch is unit-tested from any platform.
 */
import { dirname, join } from 'node:path'

export interface Invocation {
  file: string
  args: string[]
}

/** The ambient facts `resolveInvocation` needs, injected so tests can vary them. */
export interface SpawnEnvironment {
  platform: string
  /** The absolute path of the currently running Node binary. */
  execPath: string
  /** npm sets this to its own cli.js when it spawns a lifecycle script. */
  npmExecPath: string | undefined
  exists: (path: string) => boolean
}

export class NpmNotFoundError extends Error {
  constructor() {
    super(
      'could not locate npm-cli.js next to the running Node binary. ' +
        'Reinstall Node with its bundled npm, or run this scaffolder under npm.'
    )
    this.name = 'NpmNotFoundError'
  }
}

/** npm's JavaScript entrypoint, which `node` can execute directly. */
function npmCliPath(env: SpawnEnvironment): string | undefined {
  const fromNpm = env.npmExecPath
  if (fromNpm !== undefined && fromNpm.endsWith('.js') && env.exists(fromNpm)) return fromNpm

  const bundled = join(dirname(env.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return env.exists(bundled) ? bundled : undefined
}

export function resolveInvocation(
  command: string,
  args: readonly string[],
  env: SpawnEnvironment
): Invocation {
  // `node` is a real executable on every platform, never a shim.
  if (command !== 'npm') return { file: command, args: [...args] }

  // Elsewhere npm is a script with a shebang, which spawn executes directly.
  if (env.platform !== 'win32') return { file: 'npm', args: [...args] }

  const cli = npmCliPath(env)
  if (cli === undefined) throw new NpmNotFoundError()

  return { file: env.execPath, args: [cli, ...args] }
}
