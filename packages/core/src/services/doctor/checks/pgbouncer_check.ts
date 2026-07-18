import { getConfig } from '../../../config.js'
import {
  determinePgBouncerPosture,
  getDetectedPgBouncerPosture,
} from '../../isolation/pgbouncer_probe.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

/**
 * F3 — report the PgBouncer posture. Prefers the posture the boot probe recorded;
 * falls back to deriving it from config (so the check is meaningful even if the
 * probe has not run, e.g. in a diagnostic-only invocation). Purely informational:
 * it never fails a deploy on its own and reflects that detection touches no cap.
 *
 *  - `off` (or unconfigured): nothing to report.
 *  - `transaction` / `session` (declared): an `info` line confirming the mode and
 *    that the tenant routing path is pooler-safe.
 *  - `auto` that could not confirm a mode: a `warn` advising an explicit
 *    declaration (transaction pooling is never assumed).
 */
const pgBouncerCheck: DoctorCheck = {
  name: 'pgbouncer',
  description: 'Reports the detected/declared PgBouncer pooling posture and its pooler-safety.',

  async run(): Promise<DiagnosisIssue[]> {
    const posture =
      getDetectedPgBouncerPosture() ?? determinePgBouncerPosture(getConfig().isolation.pgBouncer)

    if (posture.mode === 'off') return []

    if (posture.mode === 'unknown') {
      return [{ code: 'pgbouncer_mode_unknown', severity: 'warn', message: posture.note }]
    }

    return [{ code: `pgbouncer_mode_${posture.mode}`, severity: 'info', message: posture.note }]
  },
}

export default pgBouncerCheck
