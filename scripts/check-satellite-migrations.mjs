#!/usr/bin/env node
// Guard against a silent per-tenant-migration compilation drift.
//
// A satellite that ships per-tenant migrations (SEAM-2) declares the COMPILED
// output dir in its manifest (`lasagnaSatellite.perTenantMigrations`, e.g.
// "build/tenant_migrations"). `tenant:migrate` discovers that path from
// node_modules and folds it into the run. But the files only reach `build/` if
// the package's tsconfig `include` covers the SOURCE dir. Drop that include line
// in a refactor and there is NO error: tsc emits nothing there, `tenant:migrate`
// discovers an empty/absent dir, and a tenant boots with no table. The same
// silent-drift class as check-bench-paths / check-doc-paths.
//
// For every package declaring `perTenantMigrations`, this asserts three things
// agree, pre-build: (a) the source dir exists and holds >=1 .ts migration, (b)
// the tsconfig `include` covers it, (c) the declared output path is that dir's
// tsc output (outDir/rootDir mapping). Linear I/O over a handful of manifests.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonc } from './read-jsonc.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Normalize a tsconfig dir option ("./build", "build/", "build") to "build". */
function normDir(value, fallback) {
  return (value ?? fallback).replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Audit one satellite's per-tenant-migration wiring. Pure over its inputs (an
 * injected tsconfig object and a `.ts` lister) so it is unit-testable without a
 * filesystem. `listTsFiles(srcRel)` returns the `.ts` file names in that source
 * dir, or `null` when the dir is missing. Returns problem strings (empty = ok).
 */
export function auditManifestMigrations(name, out, tsconfig, listTsFiles) {
  const problems = []
  const outDir = normDir(tsconfig.compilerOptions?.outDir, 'build')
  const rootDir = normDir(tsconfig.compilerOptions?.rootDir, '.')
  const include = Array.isArray(tsconfig.include) ? tsconfig.include : []

  if (out !== outDir && !out.startsWith(outDir + '/')) {
    problems.push(
      `${name}: perTenantMigrations "${out}" is not under the tsconfig outDir "${outDir}/", so tsc never emits it`
    )
    return problems
  }

  const relFromOut = out.slice(outDir.length).replace(/^\//, '')
  const srcRel = rootDir === '.' || rootDir === '' ? relFromOut : `${rootDir}/${relFromOut}`

  const files = listTsFiles(srcRel)
  if (files === null) {
    problems.push(
      `${name}: per-tenant migration source dir "${srcRel}" is missing (declared output "${out}")`
    )
  } else if (files.length === 0) {
    problems.push(`${name}: per-tenant migration source dir "${srcRel}" holds no .ts migration`)
  }

  const covered = include.some((glob) => glob === srcRel || glob.startsWith(srcRel + '/'))
  if (!covered) {
    problems.push(
      `${name}: tsconfig "include" does not cover "${srcRel}"; tsc will not emit "${out}" and ` +
        `tenant:migrate will discover nothing. Add "${srcRel}/**/*.ts" to include.`
    )
  }
  return problems
}

function run() {
  const pkgFiles = execFileSync('git', ['ls-files', 'packages/*/package.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const problems = []
  let checked = 0
  for (const rel of pkgFiles) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'))
    const out = pkg.lasagnaSatellite?.perTenantMigrations
    if (!out) continue
    checked++
    const pkgDir = join(repoRoot, dirname(rel))
    // The config that GOVERNS EMISSION is what matters here, and since the
    // typecheck/build split that is tsconfig.build.json, not tsconfig.json. The
    // typecheck config no longer carries outDir (it must not emit), so reading it
    // would test the wrong file. Fall back to tsconfig.json for a package that has
    // not split. Both are JSONC: they carry comments documenting the split.
    const buildConfigPath = join(pkgDir, 'tsconfig.build.json')
    const tsconfigPath = existsSync(buildConfigPath)
      ? buildConfigPath
      : join(pkgDir, 'tsconfig.json')
    const tsconfig = readJsonc(tsconfigPath)
    const listTsFiles = (srcRel) => {
      const abs = join(pkgDir, srcRel)
      if (!existsSync(abs)) return null
      return readdirSync(abs).filter((f) => f.endsWith('.ts'))
    }
    problems.push(
      ...auditManifestMigrations(pkg.lasagnaSatellite.name ?? pkg.name, out, tsconfig, listTsFiles)
    )
  }

  if (problems.length > 0) {
    console.error(
      `check-satellite-migrations: ${problems.length} per-tenant-migration wiring problem(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-satellite-migrations: OK (${checked} satellite(s) with per-tenant migrations wired correctly).`
  )
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
