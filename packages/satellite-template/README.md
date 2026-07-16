# @adonisjs-lasagna/satellite-template

A **reference template** for building a packaged [Lasagna](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy)
satellite. It is `private` and never published — it lives in the monorepo so the
public satellite contract is compiled and unit-tested against a fresh consumer in
CI. Copy it as the starting point for your own satellite.

See the full guide: **[Creating a satellite](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/cookbook/creating-a-satellite)**.

## What it demonstrates

| Piece | File |
|---|---|
| The `lasagnaSatellite` manifest | `package.json` |
| The configure hook (publishes its own migration) | `configure.ts` |
| A provider built with the `definePlugin` facade + self-registering a hook | `providers/example_provider.ts` |
| A backoffice migration stub | `stubs/migrations/create_example_widgets_table.stub` |
| The service contract + Lucid-backed implementation | `src/types.ts`, `src/example_widget.ts`, `src/example_widget_service.ts` |
| A copyable `InMemoryStore` + an in-memory test double | `src/testing/in_memory_store.ts`, `src/testing/in_memory_widget_store.ts` |
| An ace command + loader | `src/commands/` |
| A hermetic unit test (no DB) | `tests/@guarantees/behavior/unit/` |

## The rule

A satellite depends on core; **core never imports a satellite**. The provider
self-registers against core's public registries (`HookRegistry`, `DoctorService`,
the queue `Locator`, …) instead of being wired by core.

## Install (in a host app)

```bash
node ace configure @adonisjs-lasagna/satellite-template
# or, alongside other satellites, via core:
node ace configure @adonisjs-lasagna/saas-tenancy --with=@adonisjs-lasagna/satellite-template
```
