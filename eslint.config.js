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
  {
    // E1 rigor, scoped to the `/plugin` public surface (the plan's "superficie
    // /plugin a prueba de balas"). A repo-wide ban would break existing code, so
    // it is LOCAL to these files and enforced like every other invariant. The
    // compiler-flag leg (a scoped tsconfig with exactOptionalPropertyTypes /
    // noImplicitOverride) is deliberately NOT used: those flags leak into
    // transitively-imported shared files and conflict with the repo's exception
    // conventions. no-explicit-any + no-non-null-assertion scope cleanly per-file;
    // the closed `switch (entry.kind)` + assertNever already gives compile-time
    // exhaustiveness, and plugin_type_safety.spec.ts is the lexical backstop.
    files: [
      'packages/core/src/sdk/plugin.ts',
      'packages/core/src/sdk/define_plugin.ts',
      'packages/core/src/sdk/builders.ts',
      'packages/core/src/sdk/brands.ts',
      'packages/core/src/sdk/plugin_permissions.ts',
      'packages/core/src/sdk/plugin_env.ts',
      'packages/core/src/sdk/plugin_keys.ts',
      'packages/core/src/sdk/assert_never.ts',
      'packages/core/src/sdk/capabilities.ts',
      'packages/core/src/sdk/plugin_api_version.ts',
      'packages/core/src/services/authorizer_registry.ts',
      'packages/core/src/services/tenant_middleware_registry.ts',
      'packages/core/src/services/capability_registry.ts',
      'packages/core/src/services/tenant_scheduler_service.ts',
      'packages/core/src/events/tenant_data_changed.ts',
      'packages/core/src/exceptions/plugin_exception.ts',
      'packages/core/src/exceptions/plugin_authorizer_exception.ts',
      'packages/core/src/exceptions/plugin_boot_exception.ts',
      'packages/core/src/exceptions/plugin_middleware_exception.ts',
      'packages/core/src/exceptions/request_macro_collision_exception.ts',
      'packages/core/src/exceptions/capability_collision_exception.ts',
      'packages/core/src/exceptions/capability_trust_exception.ts',
      'packages/core/src/exceptions/unauthorized_core_access_exception.ts',
      'packages/core/src/exceptions/scheduler_tick_exception.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
]
