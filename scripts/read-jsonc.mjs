import { readFileSync } from 'node:fs'

/**
 * Parse a JSONC file (JSON with comments).
 *
 * TypeScript's tsconfig files are JSONC by design: `//` and block comments are
 * legal and used to document why an include or a compiler option is the way it is.
 * `JSON.parse` chokes on them, so any guard that reads a tsconfig with plain
 * `JSON.parse` breaks the moment someone documents it. This is the shared reader
 * so that class of failure is fixed in one place rather than rediscovered per guard.
 *
 * The comment stripper preserves anything that merely looks like a comment inside a
 * string (a `//` in a URL, a `/*` in a pattern), by consuming whole string literals
 * before it considers a comment. Trailing commas are then removed, since JSONC and
 * real tsconfig files allow them too.
 */
export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out += ch
      }
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    out += ch
  }
  // Drop trailing commas (`,` before a closing `}` or `]`), which JSONC allows.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** Read and parse a JSONC file from disk. */
export function readJsonc(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))
}
