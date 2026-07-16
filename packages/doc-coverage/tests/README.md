# doc-coverage tests

This package sits outside the guarantee tree. doc-coverage is a build-time
code-to-docs drift tool, not part of the multitenancy runtime, so its tests are
plain `*.test.ts` files run directly rather than japa `*.spec.ts` under
`@guarantees`.

The suite covers the contract hash, the freshness checkpoint, the symbol graph,
the RFC status guard, CRLF handling, and tuning, with shared mock projects under
`fixtures/`. There is no `@guarantees` / `@architecture` / `@integration`
skeleton here by design.
