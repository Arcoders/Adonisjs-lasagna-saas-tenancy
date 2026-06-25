import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = 'https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy'
const CHANGELOG_PATH = resolve(__dirname, '../../packages/core/CHANGELOG.md')
const TARGET_PATH = resolve(__dirname, '../reference/release-notes.md')
const REDIRECTS_PATH = resolve(__dirname, '../redirects.json')

// The satellites version independently and keep their own canonical changelogs.
// Surface them as a linked index (name + current version) rather than inlining
// every entry, so the page stays focused on the core's substantive changelog.
const SATELLITES = ['sso', 'billing', 'admin', 'backup']

const raw = readFileSync(CHANGELOG_PATH, 'utf8')

let body = raw.replace(/^# Changelog\s*\n/, '').trimStart()

// The CHANGELOG is the canonical historical record and still references the
// pre-restructure `/docs/*` URLs. Normalise them to the new Start/Guides/Reference
// paths on the generated page (longest-first so a page URL is rewritten before any
// shorter prefix), so the dead-link check passes without editing release history.
const redirects = JSON.parse(readFileSync(REDIRECTS_PATH, 'utf8'))
for (const [oldUrl, newUrl] of Object.entries(redirects).sort((a, b) => b[0].length - a[0].length)) {
  body = body.split(oldUrl).join(newUrl)
}

const satelliteRows = SATELLITES.map((dir) => {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, `../../packages/${dir}/package.json`), 'utf8')
  )
  return `| [\`${pkg.name}\`](${REPO}/blob/master/packages/${dir}/CHANGELOG.md) | ${pkg.version} |`
}).join('\n')

const satellites = `

---

## Satellite packages

The satellites version independently of the core. Each keeps its own canonical changelog in
the repo:

| Package | Current version |
|---|---|
${satelliteRows}
`

const frontmatter = `---
title: Release notes
description: Auto-generated from the core package's CHANGELOG.md, which is canonical.
---

# Release notes

> Auto-generated from
> [\`packages/core/CHANGELOG.md\`](${REPO}/blob/master/packages/core/CHANGELOG.md)
> at build time. The repo file is canonical.

`

writeFileSync(TARGET_PATH, frontmatter + body + satellites, 'utf8')

console.log(`[docs] wrote ${TARGET_PATH}`)
