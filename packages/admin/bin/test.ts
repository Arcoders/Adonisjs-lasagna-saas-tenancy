import { runUnitSuite } from '../../satellite-test-kit/src/runner_entries.js'

// Unit specs (no-DB, source harness). Globs and Japa config come from the shared
// kit so every satellite's unit runner is one identical line; see runUnitSuite.
runUnitSuite()
