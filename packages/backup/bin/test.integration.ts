import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// backup's integration tier boots through the shared satellite-test-kit, the same
// Ignitor + DDL bootstrap + exit-code recompute core uses. It reuses core's
// canonical fixture app, which already loads the backup provider + commands, so
// BackupService / BackupRetentionService / CloneService run against a real PG (and
// MinIO when BACKUP_S3_ENDPOINT is set). The suite glob is cwd-relative, so it picks
// up backup's own tests/integration/** specs.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().integration,
})
