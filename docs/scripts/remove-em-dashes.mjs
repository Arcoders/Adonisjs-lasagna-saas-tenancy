/**
 * One-shot pass to remove em-dashes from docs prose.
 *
 * Rules (applied in order):
 *   1. " — " (space + em-dash + space) between sentences/clauses → "; "
 *      Semicolon-space is the closest grammatical equivalent that never
 *      breaks reading flow.
 *   2. "— " at the start of a list-item dash (e.g., "— Author Name") → "by "
 *      That's the showcase/testimonial-attribution pattern.
 *   3. en-dash "–" gets the same treatment as em-dash.
 *
 * Skips: code fences (``` … ```) and inline code (`…`). We don't want to
 * rewrite ASCII art, command examples, or strings that happen to contain
 * a real em-dash.
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = resolve(__dirname, '..')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'public' || entry === 'scripts') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

function rewriteProse(line) {
  return line
    // " — " or " – " between clauses → "; "
    .replace(/ [—–] /g, '; ')
    // "— " at start of a line/list item (testimonial attribution pattern)
    .replace(/^—\s+/g, 'by ')
    .replace(/^–\s+/g, 'by ')
    // Lingering bare " —" or "— " (orphaned after the prior rules)
    .replace(/\s[—–]\s/g, '; ')
    .replace(/[—–]/g, ',')
}

function rewriteFile(path) {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n')
  let inFence = false
  const out = lines.map((line) => {
    if (line.trim().startsWith('```')) {
      inFence = !inFence
      return line
    }
    if (inFence) return line

    // Split off inline code spans so we don't rewrite content inside backticks.
    const parts = line.split(/(`[^`]*`)/g)
    return parts
      .map((part) => (part.startsWith('`') && part.endsWith('`') ? part : rewriteProse(part)))
      .join('')
  })
  const next = out.join('\n')
  if (next !== raw) {
    writeFileSync(path, next, 'utf8')
    return true
  }
  return false
}

let changed = 0
for (const file of walk(DOCS_DIR)) {
  if (rewriteFile(file)) {
    changed += 1
    console.log(`[em-dash] rewrote ${file}`)
  }
}
console.log(`[em-dash] ${changed} files modified`)
