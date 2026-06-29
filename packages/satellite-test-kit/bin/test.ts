import { runUnitSuite } from '../src/runner_entries.js'

// The kit dogfoods its own unit runner: the guarantee-tree globs and Japa config
// live in runUnitSuite, so this collapses to one line like every package's runner.
runUnitSuite()
