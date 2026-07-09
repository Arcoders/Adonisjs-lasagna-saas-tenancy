#!/usr/bin/env node
/**
 * Stub-render guard.
 *
 * `node ace configure <pkg>` renders every stub through AdonisJS's Stub class,
 * which does `tempura.compile(contents)(data)` — it builds a JavaScript template
 * literal out of the file. So an unescaped backtick, `${` or backslash anywhere
 * in a stub BODY either aborts compilation (`configure` throws) or silently
 * corrupts the file it writes into the user's app.
 *
 * Nothing caught this: the unit specs stub out `makeUsingStub`, and the demo app
 * was hand-written rather than generated. 22 of the repo's 30 stubs could not be
 * rendered at all, so `configure` published nothing.
 *
 * The invariant, checked here for every stub: the body must compile, and escaping
 * what it renders must give the body back. That is stronger than "it compiles" —
 * it also catches a `${foo}` that compiles but interpolates away, and a literal
 * `\n` that turns into a real newline. (Note the direction: a correctly escaped
 * body never renders to *itself*, by construction. Escaping the render does.)
 *
 * The frontmatter (`{{{ … }}}`) is exempt: it is real JavaScript that tempura
 * evaluates, so backticks there are legitimate.
 *
 * Usage: node scripts/check-stub-render.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { compile } = await import(pathToFileURL(require.resolve('tempura')).href)

/** Everything after the frontmatter block; the whole file when there is none. */
export function stubBody(source) {
  const close = source.indexOf('}}}')
  return close >= 0 ? source.slice(close + 3) : source
}

/** The `{{{ … }}}` frontmatter, which tempura evaluates as JavaScript. */
export function stubFrontmatter(source) {
  const close = source.indexOf('}}}')
  return close >= 0 ? source.slice(0, close) : ''
}

/**
 * Path helpers on AdonisJS's Application. There is no `appPath` — `tenant.stub`
 * called it for a year and nothing noticed, because `configure` never got far
 * enough to render that stub. Sorted, so the failure message reads usefully.
 */
const APPLICATION_PATH_HELPERS = new Set([
  'commandsPath', 'configPath', 'contractsPath', 'eventsPath', 'exceptionsPath',
  'factoriesPath', 'generatedClientPath', 'generatedServerPath', 'httpControllersPath',
  'languageFilesPath', 'listenersPath', 'mailersPath', 'mailsPath', 'makePath',
  'middlewarePath', 'migrationsPath', 'modelsPath', 'policiesPath', 'providersPath',
  'publicPath', 'relativePath', 'seedersPath', 'servicesPath', 'startPath', 'tmpPath',
  'transformersPath', 'validatorsPath', 'viewsPath',
])

/** Report frontmatter that calls an `app.<x>()` helper that does not exist. */
export function unknownPathHelpers(frontmatter) {
  const called = [...frontmatter.matchAll(/\bapp\.([A-Za-z]+)\s*\(/g)].map((m) => m[1])
  return [...new Set(called.filter((name) => !APPLICATION_PATH_HELPERS.has(name)))]
}

/**
 * Neutralise everything tempura would act on, so the body renders to itself.
 *
 * The first three are special inside the JS template literal tempura builds. The
 * fourth is tempura's own interpolation opener: an Edge view stub is full of
 * `{{ name }}`, which tempura would evaluate (and crash on) at publish time. A
 * bare `}}` is harmless — with no opener there is nothing for it to close — so
 * only the opener is rewritten, into an expression that prints itself.
 */
export function escapeStubBody(body) {
  return body.replace(/\\|`|\$\{|\{\{/g, (match) =>
    match === '{{' ? "{{ '{{' }}" : '\\' + match
  )
}

/**
 * tempura drops the trailing newline (AdonisJS `.trim()`s the render anyway) and
 * normalizes CRLF to LF. Neither changes the generated file's meaning.
 */
const normalize = (s) => s.replace(/\r\n/g, '\n').trim()

/** Render a body and report how it betrays its source, or null when faithful. */
export function renderDrift(body) {
  let rendered
  try {
    rendered = compile(body, { props: [] })({})
  } catch (error) {
    return `does not compile: ${error.message}`
  }
  const reEscaped = normalize(escapeStubBody(rendered))
  const source = normalize(body)
  if (reEscaped !== source) {
    let i = 0
    while (i < source.length && source[i] === reEscaped[i]) i++
    return `renders to different text near offset ${i}: ${JSON.stringify(
      source.slice(Math.max(0, i - 30), i + 30)
    )} became ${JSON.stringify(reEscaped.slice(Math.max(0, i - 30), i + 30))}`
  }
  return null
}

if (process.argv.includes('--self-test')) {
  const problems = []
  const flagged = (body) => renderDrift(body) !== null
  const BT = String.fromCharCode(96)

  const OPENER = '{' + '{'
  if (!flagged(`a ${BT}x${BT} b`)) problems.push('raw backtick not flagged')
  if (!flagged('a ${x} b')) problems.push('raw ${} not flagged')
  if (!flagged('a \\n b')) problems.push('literal backslash-n not flagged')
  if (!flagged(`${OPENER} quota }}`)) problems.push('raw edge interpolation not flagged')
  if (flagged(escapeStubBody(`a ${BT}x${BT} b`))) problems.push('escaped backtick flagged')
  if (flagged(escapeStubBody('a ${x} b'))) problems.push('escaped ${} flagged')
  if (flagged(escapeStubBody('a \\n b'))) problems.push('escaped backslash-n flagged')
  if (flagged(escapeStubBody(`${OPENER} quota }}`)))
    problems.push('escaped edge interpolation flagged')
  if (flagged('plain text')) problems.push('plain text flagged')

  if (unknownPathHelpers("exports({ to: app.appPath('x') })").length !== 1)
    problems.push('unknown path helper app.appPath not flagged')
  if (unknownPathHelpers("exports({ to: app.modelsPath('x') })").length !== 0)
    problems.push('known path helper app.modelsPath flagged')

  if (problems.length) {
    console.error('check-stub-render --self-test: FAIL')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('check-stub-render --self-test: OK')
  process.exit(0)
}

// Only sweep the repo when run as a script. The helpers above are imported by
// tooling that must not inherit this file's `process.exit`.
if (import.meta.main) {
  const files = execSync('git ls-files "packages/**/*.stub"', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)

  const failures = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const drift = renderDrift(stubBody(source))
    if (drift) failures.push(`${file}: ${drift}`)
    for (const helper of unknownPathHelpers(stubFrontmatter(source))) {
      failures.push(
        `${file}: frontmatter calls app.${helper}(), which AdonisJS's Application does not expose`
      )
    }
  }

  console.log(`Stub render: checked ${files.length} stub(s)`)

  if (failures.length > 0) {
    console.error('\ncheck-stub-render: FAIL')
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(
      '\nEscape the stub BODY for tempura: ` -> \\` , ${ -> \\${ , \\ -> \\\\ ,' +
        "\nand an Edge interpolation opener {{ -> {{ '{{' }} ." +
        '\nLeave the {{{ … }}} frontmatter alone — that is JavaScript tempura evaluates.'
    )
    process.exit(1)
  }
  console.log('\ncheck-stub-render: passed — every stub renders faithfully')
}
