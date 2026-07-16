/**
 * Strip `//` line comments and block comments from JS/TS source WITHOUT touching
 * string or template-literal contents, so a guard that greps for a token (a version
 * field, an `assertShape(` override) never misreads one that only appears inside a
 * comment — and never mistakes a `//` inside a `"https://…"` string for a comment.
 *
 * A small state machine: it tracks code / line-comment / block-comment / single /
 * double / template states and copies everything except comment bodies. It does NOT
 * model regex literals (a `/…/` regex whose body contains `//` or `/*`), which do not
 * occur next to the version/shape tokens these guards scan; worst case there is a
 * harmless over-strip far from any matched token. Good enough for first-party source
 * scanning; not a general-purpose minifier.
 */
export function stripJsComments(src) {
  let out = ''
  let state = 'code' // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const c2 = src[i + 1]
    switch (state) {
      case 'code':
        if (c === '/' && c2 === '/') {
          state = 'line'
          i++
        } else if (c === '/' && c2 === '*') {
          state = 'block'
          i++
        } else if (c === "'") {
          state = 'sq'
          out += c
        } else if (c === '"') {
          state = 'dq'
          out += c
        } else if (c === '`') {
          state = 'tpl'
          out += c
        } else {
          out += c
        }
        break
      case 'line':
        if (c === '\n') {
          state = 'code'
          out += c
        }
        break
      case 'block':
        if (c === '*' && c2 === '/') {
          state = 'code'
          i++
        }
        break
      case 'sq':
      case 'dq':
      case 'tpl':
        out += c
        if (c === '\\') {
          out += c2 ?? ''
          i++
        } else if (
          (state === 'sq' && c === "'") ||
          (state === 'dq' && c === '"') ||
          (state === 'tpl' && c === '`')
        ) {
          state = 'code'
        }
        break
    }
  }
  return out
}
