# satellite-test-kit test tree

Tests are organised by **guarantee** (what the system promises), not by mechanism.
The harness (unit vs integration) is the leaf inside each guarantee, so a runner
still selects only the specs it can run.

```
tests/
  @guarantees/<g>/{unit,integration}/   g = isolation | security | behavior | resilience | performance
  @architecture/{boundaries,contracts,docs}/   static guards (unit harness)
  @integration/drivers/                 gating stack tier
  helpers/                              shared, non-spec support
```

unit specs run against source with tsx and no database; integration specs boot
the shared Ignitor and PostgreSQL. Every package ships the same skeleton so the
layout reads the same everywhere; empty slots carry a README until specs arrive.
The chaos tier (`@integration/fault_injection`) and the fixture app
(`tests/fixtures`) live only in core.

Name guarantee specs `<guarantee>_<context>_<outcome>.spec.ts`. The
`@architecture/boundaries/<pkg>_guarantee_tree` spec calls the kit's
`assertGuaranteeTree`, so this layout is pinned against the single-sourced
taxonomy and cannot drift unnoticed.
