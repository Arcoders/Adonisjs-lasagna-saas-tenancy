/**
 * A best-effort logger shim safe to import at MODULE TOP LEVEL from code that must
 * also load outside an Ignitor — the bare unit runner. The framework logger service
 * (`@adonisjs/core/services/logger`) top-level-`await`s `app.booted(...)`, so a
 * STATIC `import logger from '@adonisjs/core/services/logger'` crashes any unit spec
 * that pulls the module into its import graph (the doctor checks do, via the
 * safe-fix envelope). This lazily imports the real logger only when a message is
 * actually emitted, and swallows the failure, so the import graph stays Ignitor-free
 * while still logging in a booted app.
 *
 * Its `{ warn, warning }` shape also satisfies the ace-style command-logger the
 * `auditCliAction` helper expects, so it can stand in for `this.logger` off the CLI.
 */
function lazyWarn(message: string): void {
  void import('@adonisjs/core/services/logger')
    .then((m) => m.default.warn(message))
    .catch(() => {})
}

export const lazyLogger = {
  warn: lazyWarn,
  warning: lazyWarn,
}
