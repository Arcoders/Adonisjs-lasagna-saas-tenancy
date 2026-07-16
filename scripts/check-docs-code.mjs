// Docs code-fence import gate (Workstream D, test 4).
//
// Extracts every ```ts / ```typescript fence from docs/**/*.md and type-checks it
// against the REAL built package types (NodeNext + decorators, mirroring the repo
// tsconfig). Run AFTER `npm run build:all` so the satellites' build/*.d.ts exist.
//
// What it GATES on: every `@adonisjs-lasagna/*` import in the docs must resolve to a
// real exported symbol. This is the doc-drift that actually breaks a reader's
// copy-paste — a wrong subpath or a renamed/removed export (e.g. importing billing
// events from `/saas-tenancy/events` instead of `@adonisjs-lasagna/billing`).
//
// What it does NOT gate on: the bodies of didactic fragments. Doc snippets reference
// undeclared placeholders (`order`, `cart`), host-app aliases (`#models/user`), and
// vendor libs the docs don't install; compiling those produces noise, not bugs. So a
// small ambient prelude declares the ubiquitous bindings as `any`, each statement
// fragment is wrapped in a function, and only diagnostics that name an
// `@adonisjs-lasagna/*` module are treated as failures.
//
// Directive (place on its own line just above a fence):
//   <!-- compile: skip -->   don't compile this fence (an intentionally-old "// Before"
//                            migration example, or one that uses an internal test seam).
//
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS = join(ROOT, 'docs')
const TMP = join(ROOT, '.docs-code-tmp')

const COMPILER_OPTIONS = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  strict: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  useUnknownInCatchVariables: false,
  skipLibCheck: true,
  noEmit: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
  allowJs: false,
  esModuleInterop: true,
  resolveJsonModule: true,
  types: [],
}

// Ambient bindings that doc fragments reference without importing. Declared `any`
// so a fragment compiles, while real imports + explicitly-typed code stay checked.
const PRELUDE = `
export {}
declare global {
  const app: any; const ctx: any; const request: any; const response: any
  const tenant: any; const user: any; const db: any; const trx: any
  const router: any; const middleware: any; const emitter: any; const auth: any
  const config: any; const logger: any; const next: any
}
`

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    if (e === '.vitepress' || e === 'public' || e === 'node_modules') continue
    const f = join(dir, e)
    const s = statSync(f)
    if (s.isDirectory()) out.push(...walk(f))
    else if (e.endsWith('.md')) out.push(f)
  }
  return out
}

// Extract fenced ts blocks + the line they start on + any directive just above.
function extractBlocks(md, content) {
  const lines = content.split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const open = lines[i].match(/^```(ts|typescript)\b/)
    if (open) {
      const startLine = i + 1
      const body = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      // look back past blank lines for a directive comment
      let j = startLine - 2
      while (j >= 0 && lines[j].trim() === '') j--
      const directive = j >= 0 ? (lines[j].match(/<!--\s*compile:\s*(skip|fragment)\s*-->/)?.[1] ?? null) : null
      blocks.push({ md, startLine, code: body.join('\n'), directive })
    }
    i++
  }
  return blocks
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
writeFileSync(join(TMP, 'prelude.d.ts'), PRELUDE)

const rootNames = [join(TMP, 'prelude.d.ts')]
const fileMeta = new Map() // tmp file -> { md, startLine }
let total = 0, skipped = 0
for (const md of walk(DOCS)) {
  const content = readFileSync(md, 'utf8')
  const blocks = extractBlocks(md, content)
  blocks.forEach((b, idx) => {
    total++
    if (b.directive === 'skip') { skipped++; return }
    // A block with a top-level import/export is a complete module — compile as-is.
    // A pure-statement fragment is wrapped so top-level statements/await/return are
    // legal and its locals stay block-scoped (and an `export {}` makes it a module).
    const isModule = /^\s*(import|export)\s/m.test(b.code)
    const wrapped = isModule
      ? `${b.code}\n${/^\s*export\s/m.test(b.code) ? '' : 'export {}\n'}`
      : `export {}\nasync function __doc_block__() {\n${b.code}\n}\n`
    const rel = relative(DOCS, b.md).replace(/[\\/]/g, '__').replace(/\.md$/, '')
    const tmp = join(TMP, `${rel}__${idx}.ts`)
    writeFileSync(tmp, wrapped)
    fileMeta.set(tmp, { md: b.md, startLine: b.startLine })
    rootNames.push(tmp)
  })
}

const program = ts.createProgram(rootNames, COMPILER_OPTIONS)
const diagnostics = ts.getPreEmitDiagnostics(program)

// Gate only on import errors that name one of OUR packages: module-not-found and
// no-exported-member. Everything else (placeholder vars, vendor libs, body types) is
// the inherent noise of compiling fragments and is intentionally ignored.
const IMPORT_ERROR_CODES = new Set([
  2307, // cannot find module
  2305, // module has no exported member 'X'
  2724, // no exported member named 'X' (did you mean …)
  2614, // no exported member 'X' (use `import type`)
  2306, // file is not a module
])
const failures = []
for (const d of diagnostics) {
  if (!d.file) continue
  const meta = fileMeta.get(d.file.fileName.replace(/\//g, '\\')) ?? fileMeta.get(d.file.fileName)
  if (!meta) continue // prelude.d.ts or lib diagnostics
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
  if (!IMPORT_ERROR_CODES.has(d.code) || !/@adonisjs-lasagna\//.test(msg)) continue
  const rel = relative(ROOT, meta.md).replace(/\\/g, '/')
  failures.push(`${rel} (fence at line ~${meta.startLine}): TS${d.code} ${msg}`)
}

const checked = total - skipped
console.log(`docs code fences: ${total} total, ${skipped} skipped, ${checked} compiled`)
if (failures.length) {
  console.error(`\n${failures.length} broken @adonisjs-lasagna import(s) in docs:\n`)
  for (const f of failures) console.error('  - ' + f)
  console.error(
    '\nFix the example import (wrong subpath or renamed/removed export), or — for an' +
      '\nintentionally-old "// Before" example — mark the fence with `<!-- compile: skip -->`.'
  )
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}
rmSync(TMP, { recursive: true, force: true })
console.log('All @adonisjs-lasagna imports in docs resolve to real exports.')
