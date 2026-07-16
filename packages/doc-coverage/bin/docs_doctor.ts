/**
 * docs:doctor CLI entry. Run via tsx (no build needed):
 *   tsx packages/doc-coverage/bin/docs-doctor.ts [flags]
 */
import { main } from '../src/cli.js'

process.exit(main(process.argv.slice(2)))
