# examples/api tests

The demo app runs only the end-to-end tier, so it does not adopt the full
guarantee skeleton the packages use. Specs live under `@integration/e2e/` (with
`hardening/` for the security and resilience scenarios) and run through the app's
own ace test runner, not the kit:

```bash
cd examples/api
npx tsx ace.ts backoffice:setup
npx tsx ace.ts test e2e
```

The suite glob is defined in `adonisrc.ts`. There is no unit or per-guarantee
harness here; the guarantee tree lives in the packages under `packages/*/tests`.
`fixtures/` holds the demo app's test data.
