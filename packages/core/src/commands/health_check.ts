import { BaseCommand } from '@adonisjs/core/ace'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverSatellites } from '../sdk/configure_kit.js'
import {
  parseNpmAudit,
  countAtOrAbove,
  hasInstallScripts,
  type AuditReport,
} from '../services/supply_chain_audit.js'

/**
 * `lasagna:health-check` — a supply-chain health check the operator runs against
 * their app (S2). It runs `npm audit` over the dependency tree and flags each
 * installed satellite that ships a native addon (not sandboxable by the worker
 * Permission Model) or an install lifecycle script (the vector `--ignore-scripts`
 * blocks). It fails (exitCode 1) on a high/critical advisory so it doubles as a CI
 * gate. The parsing/threshold logic is the pure `supply_chain_audit` module; this
 * command is the thin shell that shells out and reads the satellite package.jsons.
 */
export default class HealthCheck extends BaseCommand {
  static readonly commandName = 'lasagna:health-check'
  static readonly description =
    'Supply-chain health check: npm audit of the dependency tree plus install-script ' +
    'and native-addon risk flags for installed satellites'

  static options = { startApp: false }

  async run() {
    const root = this.app.makePath()

    const audit = this.#runAudit(root)
    if (audit) {
      const { critical, high, moderate, low } = audit.bySeverity
      this.logger.info(
        `npm audit: ${audit.total} advisory(ies) — ${critical} critical, ${high} high, ` +
          `${moderate} moderate, ${low} low`
      )
      for (const a of audit.advisories) {
        if (a.severity === 'critical' || a.severity === 'high') {
          this.logger.warning(
            `  ${a.severity.toUpperCase()} ${a.name}${a.title ? ` — ${a.title}` : ''}`
          )
        }
      }
    } else {
      this.logger.warning(
        'npm audit could not be run (is npm on PATH?); skipping the advisory scan'
      )
    }

    const satellites = await discoverSatellites(root, (m) => this.logger.warning(m))
    let flagged = 0
    for (const sat of satellites) {
      const risks: string[] = []
      if (sat.manifest.nativeAddons) {
        risks.push(
          'ships native addons (not sandboxable — install with --allow-native, treat as trusted)'
        )
      }
      if (hasInstallScripts(this.#readScripts(sat.root))) {
        risks.push('has an install lifecycle script (install with --ignore-scripts and review it)')
      }
      if (risks.length > 0) {
        flagged++
        this.logger.warning(`${sat.packageName}: ${risks.join('; ')}`)
      }
    }
    if (satellites.length > 0 && flagged === 0) {
      this.logger.info(
        `${satellites.length} satellite(s) — no install-script or native-addon risk flagged`
      )
    }

    const blocking = audit ? countAtOrAbove(audit, 'high') : 0
    if (blocking > 0) {
      this.logger.error(
        `${blocking} high/critical advisory(ies) found — resolve them or run npm audit fix`
      )
      this.exitCode = 1
    }
  }

  /**
   * `npm audit --json` prints JSON to stdout and exits NON-ZERO when advisories
   * exist, so a thrown error still carries the report on `.stdout`. `shell: true`
   * lets Windows resolve `npm.cmd`; the args are static, so there is no injection.
   */
  #runAudit(root: string): AuditReport | null {
    const parse = (out: string): AuditReport | null => {
      try {
        return parseNpmAudit(JSON.parse(out))
      } catch {
        return null
      }
    }
    try {
      const out = execFileSync('npm', ['audit', '--json'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: true,
      })
      return parse(out)
    } catch (error) {
      const stdout = (error as { stdout?: unknown }).stdout
      return typeof stdout === 'string' && stdout.trim().length > 0 ? parse(stdout) : null
    }
  }

  #readScripts(pkgRoot: string): unknown {
    try {
      const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
      return (pkg as { scripts?: unknown }).scripts
    } catch {
      return undefined
    }
  }
}
