export type SqlToken =
  | { kind: 'sql'; text: string }
  | { kind: 'copy'; header: string; rows: string[] }

const COPY_FROM_STDIN_RE = /^\s*COPY\s+.+\sFROM\s+stdin\b/i

/**
 * Tagged splitter that recognizes `COPY … FROM stdin` blocks. Each COPY block
 * is emitted as a single token containing its header (the COPY statement
 * itself) and the data rows that follow it up to the `\.` terminator.
 *
 * Use this when you need to send the data section through pg-copy-streams
 * instead of treating each row as a SQL statement.
 */
export function splitSqlStatementsTagged(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  const lines = sql.split('\n')
  let buffer: string[] = []

  const flushBuffer = () => {
    if (buffer.length === 0) return
    const joined = buffer.join('\n')
    for (const stmt of splitSqlStatements(joined)) {
      tokens.push({ kind: 'sql', text: stmt })
    }
    buffer = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (COPY_FROM_STDIN_RE.test(line)) {
      flushBuffer()
      const header = line.replace(/;\s*$/, '').trim()
      const rows: string[] = []
      i++
      while (i < lines.length) {
        const rowLine = lines[i]
        if (rowLine === '\\.') {
          i++
          break
        }
        rows.push(rowLine)
        i++
      }
      tokens.push({ kind: 'copy', header, rows })
      continue
    }
    buffer.push(line)
    i++
  }

  flushBuffer()
  return tokens
}

/**
 * State-machine SQL splitter for PostgreSQL pg_dump output.
 *
 * Handles: dollar-quoted strings, single-quoted strings, line comments,
 * block comments, and psql meta-commands (\xxx).
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0

  type State = 'default' | 'single_quote' | 'line_comment' | 'block_comment' | 'dollar_quote'

  let state: State = 'default'
  let dollarTag = ''

  const len = sql.length

  while (i < len) {
    const ch = sql[i]
    const next = sql[i + 1] ?? ''

    switch (state) {
      case 'default': {
        if (ch === '-' && next === '-') {
          state = 'line_comment'
          current += ch
          i++
          break
        }

        if (ch === '/' && next === '*') {
          state = 'block_comment'
          current += ch
          i++
          break
        }

        if (ch === "'") {
          state = 'single_quote'
          current += ch
          i++
          break
        }

        if (ch === '$') {
          const tagMatch = sql.slice(i).match(/^(\$[A-Za-z0-9_]*\$)/)
          if (tagMatch) {
            dollarTag = tagMatch[1]
            state = 'dollar_quote'
            current += dollarTag
            i += dollarTag.length
            break
          }
        }

        if (ch === ';') {
          const stmt = current.trim()
          if (stmt.length > 0) {
            statements.push(stmt)
          }
          current = ''
          i++
          break
        }

        if (ch === '\\' && (i === 0 || sql[i - 1] === '\n')) {
          const eol = sql.indexOf('\n', i)
          i = eol === -1 ? len : eol + 1
          break
        }

        current += ch
        i++
        break
      }

      case 'single_quote': {
        current += ch
        if (ch === "'" && next === "'") {
          current += next
          i += 2
          break
        }
        if (ch === "'") {
          state = 'default'
        }
        i++
        break
      }

      case 'line_comment': {
        current += ch
        if (ch === '\n') {
          state = 'default'
        }
        i++
        break
      }

      case 'block_comment': {
        current += ch
        if (ch === '*' && next === '/') {
          current += next
          i += 2
          state = 'default'
          break
        }
        i++
        break
      }

      case 'dollar_quote': {
        if (sql.slice(i, i + dollarTag.length) === dollarTag) {
          current += dollarTag
          i += dollarTag.length
          state = 'default'
          dollarTag = ''
          break
        }
        current += ch
        i++
        break
      }
    }
  }

  const trailing = current.trim()
  if (trailing.length > 0 && trailing !== ';') {
    statements.push(trailing)
  }

  return statements
}
