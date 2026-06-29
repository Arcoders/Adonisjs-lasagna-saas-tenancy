import { runUnitSuite } from '../../satellite-test-kit/src/runner_entries.js'

// Unit + architectural specs (the no-DB, source harness). The globs and Japa
// config live in the shared kit so every package's unit runner collapses to one
// identical line; see runUnitSuite. Imported from the kit SOURCE (not its build)
// so the fast unit loop still needs no build step.
runUnitSuite({ withArchitecture: true })
