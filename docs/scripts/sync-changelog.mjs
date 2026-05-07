import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CHANGELOG_PATH = resolve(__dirname, '../../CHANGELOG.md')
const TARGET_PATH = resolve(__dirname, '../docs/release-notes.md')

const raw = readFileSync(CHANGELOG_PATH, 'utf8')

const body = raw.replace(/^# Changelog\s*\n/, '').trimStart()

const frontmatter = `---
title: Release notes
description: Auto-generated from CHANGELOG.md. The canonical changelog lives in the repo root.
---

# Release notes

> Auto-generated from
> [\`CHANGELOG.md\`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/CHANGELOG.md)
> at build time. The repo file is canonical.

`

writeFileSync(TARGET_PATH, frontmatter + body, 'utf8')

console.log(`[docs] wrote ${TARGET_PATH}`)
