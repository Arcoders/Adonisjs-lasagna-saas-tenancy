#!/usr/bin/env node
/**
 * `create-lasagna-saas` scaffolds an AdonisJS 7 app with Lasagna already wired.
 *
 * Thin by design. It parses argv, builds a plan, and either prints it or runs it.
 * All three of those live in `src/`, and all of the logic is unit-tested there.
 */
import { InvalidOptionError, parseOptions } from '../src/options.js'
import { nextSteps, planActions } from '../src/plan.js'
import { execute } from '../src/run.js'
import { databaseName } from '../src/templates.js'

const USAGE = `
create-lasagna-saas — a multi-tenant AdonisJS 7 app, wired and ready to boot.

  npm create lasagna-saas@latest <directory> [options]

Options
  --with=<a,b>   Feature bundles passed to \`configure --with=\`, e.g. --with=webhooks,maintenance
  --dry-run      Print the steps that would run, and change nothing
  --help         Show this message

Needs PostgreSQL and Redis reachable when you run the generated app. The
scaffolder never touches your database.
`

function main(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(USAGE.trim())
    return 0
  }

  let options
  try {
    options = parseOptions(argv)
  } catch (error) {
    if (error instanceof InvalidOptionError) {
      console.error(`create-lasagna-saas: ${error.message}`)
      console.error('\nRun with --help for usage.')
      return 1
    }
    throw error
  }

  const actions = planActions(options)

  if (options.dryRun) {
    console.log(`Plan for ${options.directory}/ (nothing will be written):\n`)
    for (const [index, action] of actions.entries()) {
      console.log(`  ${String(index + 1).padStart(2)}. ${action.title}`)
      if (action.kind === 'run') {
        console.log(`      $ ${[action.command, ...action.args].join(' ')}  (in ${action.cwd})`)
      }
    }
    return 0
  }

  try {
    execute(actions, { parentDir: process.cwd(), directory: options.directory })
  } catch (error) {
    console.error(`\ncreate-lasagna-saas: ${error.message}`)
    return 1
  }

  console.log('\nDone. Next:\n')
  for (const step of nextSteps({
    directory: options.directory,
    databaseName: databaseName(options.directory),
  })) {
    console.log(`  ${step}`)
  }
  console.log('')
  return 0
}

process.exitCode = main(process.argv.slice(2))
