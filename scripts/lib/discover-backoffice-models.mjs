/**
 * Discover every backoffice model in the monorepo by source, so guards do not carry
 * a hand-maintained class list that silently omits a satellite's backoffice model (a
 * new one used to escape the cross-tenant guard entirely). A backoffice model is any
 * class that `extends BackofficeBaseModel`; its rows live in the shared backoffice
 * schema keyed by `tenant_id`, so an unscoped query leaks across tenants.
 *
 * Returns the sorted, de-duplicated class names. Uses `git ls-files` so it respects
 * .gitignore and never reads build output.
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const EXTENDS_BACKOFFICE = /\bclass\s+([A-Za-z0-9_]+)\s+extends\s+BackofficeBaseModel\b/g

/** Extract backoffice model class names from one file's text. */
export function backofficeModelsInText(text) {
  const names = []
  let m
  const re = new RegExp(EXTENDS_BACKOFFICE.source, 'g')
  while ((m = re.exec(text)) !== null) names.push(m[1])
  return names
}

/** Discover all backoffice model class names across tracked package sources. */
export function discoverBackofficeModels(root) {
  const tracked = execSync('git ls-files -z -- "packages/**/src/**/*.ts"', {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)

  const names = new Set()
  for (const rel of tracked) {
    for (const name of backofficeModelsInText(readFileSync(join(root, rel), 'utf8'))) {
      names.add(name)
    }
  }
  return [...names].sort()
}
