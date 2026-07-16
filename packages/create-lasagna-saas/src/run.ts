/**
 * The impure half: everything in this module touches the filesystem or spawns a
 * process. The plan it walks is built in `plan.ts` and is fully unit-tested.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Action } from './plan.js'
import { resolveInvocation, type SpawnEnvironment } from './npm.js'

export class StepFailedError extends Error {
  constructor(title: string, detail: string) {
    super(`${title}\n  ${detail}`)
    this.name = 'StepFailedError'
  }
}

/** The real ambient environment. `npm.ts` holds the logic; this is the wiring. */
const AMBIENT: SpawnEnvironment = {
  platform: process.platform,
  execPath: process.execPath,
  npmExecPath: process.env.npm_execpath,
  exists: existsSync,
}

function runStep(action: Extract<Action, { kind: 'run' }>, cwd: string): void {
  const { file, args } = resolveInvocation(action.command, action.args, AMBIENT)

  const result = spawnSync(file, args, {
    cwd,
    stdio: action.stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    ...(action.stdin === undefined ? {} : { input: action.stdin }),
  })

  if (result.error) throw new StepFailedError(action.title, result.error.message)

  // A child killed by a signal reports status null, not a number. Treating that
  // as success would march on and scaffold on top of a half-finished install.
  if (result.status !== 0) {
    const detail =
      result.status === null
        ? `killed by signal ${String(result.signal)}`
        : `exited with status ${String(result.status)}`
    throw new StepFailedError(action.title, detail)
  }
}

export function execute(
  actions: readonly Action[],
  options: { parentDir: string; directory: string }
): void {
  const appDir = resolve(options.parentDir, options.directory)

  for (const action of actions) {
    console.log(`\n==> ${action.title}`)

    if (action.kind === 'run') {
      runStep(action, action.cwd === 'parent' ? options.parentDir : appDir)
      continue
    }

    const target = join(appDir, action.path)

    if (action.kind === 'append') {
      // create-adonisjs writes .env but not always .env.example; appending to a
      // file that does not exist would create a half-populated one, so skip it
      // rather than invent it.
      if (!existsSync(target)) {
        console.log(`    skipped: ${action.path} does not exist`)
        continue
      }
      appendFileSync(target, action.contents, 'utf8')
      continue
    }

    writeFileSync(target, action.contents, 'utf8')
  }
}
