# `database-pg` no tiene cobertura de memoria / budget / catalog

**Labels:** `area/benchmarks`, `area/isolation`, `kind/gap`, `priority/blocker-1.0`

> **✅ RESUELTO (2026-06-07).** El Tier 4 corre para los 3 drivers en CI
> (`.github/workflows/benchmark.yml` y `benchmark-correctness.yml`). El catalog es driver-aware
> (`runSchemaCatalog` con la curva de bloat vía search_path vs `runDatabaseCatalog` por-base;
> rowscope se auto-salta) en `benchmarks/src/memory/catalog_bloat.bench.ts`. El conteo de backends
> de `database-pg` usa `pgBackendCountAllDatabases` (cross-DB) en `connection_budget.bench.ts`. El
> informe distingue las conclusiones por driver. Las referencias archivo:línea de abajo describen
> el estado original, ya superado.

## Resumen

El Tier 4 (memory + budget + catalog) corre **sólo** para `schema-pg`. Las conclusiones del informe
sobre memoria acotada y catalog plano se generalizan a "el paquete", pero `database-pg` —que crea
**una base de datos por tenant** y es el driver con mayor riesgo de explosión de backends y de
overhead de catálogo por-base— no tiene ni un dato de budget ni de catalog.

Además el cross-check de backends del servidor es engañoso para database-pg: en el churn aparece
`pgBackends: 1` con `tenantConnectionsOpen: 200`, porque las conexiones de database-pg van a *otras*
bases y `pgBackendCount` sólo cuenta `current_database()`.

## Evidencia (archivo:línea)

- Tier 4 sólo schema-pg en CI: `.github/workflows/benchmark.yml:137-138`.
- Catalog limitado a schema-pg en el ensamblado del tier: `benchmarks/src/memory/index.ts:26-28`.
- `pgBackendCount` mira sólo `current_database()`: `benchmarks/src/harness/introspect.ts:56-62`.

## Por qué bloquea 1.0

El informe recomienda `database-pg` para "tenants de mayor valor con aislamiento más fuerte" sin
ningún dato de su consumo de conexiones/memoria a escala. Es justo el driver donde el modelo de
recursos es más caro y menos entendido. Recomendarlo sin medirlo es una afirmación sin respaldo.

## Criterios de aceptación

- [ ] El Tier 4 (budget + catalog) corre para los **tres** drivers en CI.
- [ ] El budget de `database-pg` reporta conexiones/backends de forma correcta (contando backends en
      las bases de tenant, no sólo `current_database()`), o documenta explícitamente la limitación.
- [ ] El catalog de `database-pg` se mide según su modelo real (catálogo por-base: coste de crear/
      enumerar bases y `pg_class` por-base a medida que crecen las bases), no con la métrica de
      pg_class global de schema-pg.
- [ ] El informe distingue las conclusiones de memoria/catalog por driver en vez de generalizarlas.

## Benchmark(s) que lo cierran

B-3 (catalog realista + multi-driver) y el cambio de Tier 4 a los tres drivers (Parte C del plan).

## Opciones de solución (con trade-offs)

1. **Correr Tier 4 para los 3 drivers** (recomendado): cierra el gap directamente; alarga la corrida
   de CI (database-pg provisiona muchas bases, es lento) → cap de N para database-pg.
2. **Backend count cross-DB para database-pg**: consultar `pg_stat_activity` sin filtrar por
   `current_database()` (o sumar por base de tenant). Más fiel; algo más caro por snapshot.
3. **Sólo documentar la diferencia de modelo**: barato pero deja la recomendación de database-pg sin
   respaldo empírico; insuficiente por sí solo.
