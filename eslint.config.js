import { configApp } from '@adonisjs/eslint-config'

export default [
  // Never lint compiled output or coverage artifacts.
  { ignores: ['**/build/**', '**/coverage/**'] },
  ...configApp(),
  {
    // Scope to TypeScript sources only — mirror configApp so this block does
    // not accidentally pull compiled `.js` into the lint set.
    files: ['**/*.ts'],
    rules: {
      // Allow leading underscores on variables. The codebase uses them
      // deliberately: module-private caches (`_cache`, `_cached`,
      // `_storageProbe`) and exported-but-internal/test-only helpers
      // (`__configureTenancyForTests`, `__resetActiveDriverCache`). Renaming
      // the exported ones would break their callers; the prefix is the signal.
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allowSingleOrDouble',
        },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'class', format: ['PascalCase'] },
        { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
      ],
      // Keep strict equality everywhere except the `== null` / `!= null`
      // idiom, which intentionally matches both null and undefined.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // The flagged sites are all idiomatic `(await import('...')).default`
      // dynamic imports and lazy resolver/logger calls. Extracting each to a
      // temporary adds noise without improving safety.
      '@unicorn/no-await-expression-member': 'off',
    },
  },
]
